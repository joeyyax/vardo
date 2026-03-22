import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { orgEnvVars } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { parseEnvContent } from "@/lib/env/parse-env-content";
import { encrypt, decryptOrFallback } from "@/lib/crypto/encrypt";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createSchema = z.object({
  key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z.string(),
  description: z.string().optional(),
  isSecret: z.boolean().default(false),
});

const bulkSchema = z.object({
  content: z.string().optional(),
  vars: z.array(z.object({
    key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    value: z.string(),
    description: z.string().optional(),
    isSecret: z.boolean().default(false),
  })).optional(),
}).refine((d) => d.content !== undefined || d.vars !== undefined, {
  message: "Either content or vars required",
});

// GET — list org env vars (keys + descriptions, no secret values)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const vars = await db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, orgId),
    });

    // Decrypt and mask secret values
    const safe = vars.map((v) => ({
      ...v,
      value: v.isSecret ? "••••••••" : decryptOrFallback(v.value, orgId).content,
    }));

    return NextResponse.json({ envVars: safe });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST — create single org env var
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const valueToStore = parsed.data.isSecret
      ? encrypt(parsed.data.value, orgId)
      : parsed.data.value;

    const [created] = await db.insert(orgEnvVars).values({
      id: nanoid(),
      organizationId: orgId,
      key: parsed.data.key,
      value: valueToStore,
      description: parsed.data.description,
      isSecret: parsed.data.isSecret,
    }).returning();

    return NextResponse.json({ envVar: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
      return NextResponse.json({ error: "Variable already exists" }, { status: 409 });
    }
    return handleRouteError(error);
  }
}

// PUT — bulk upsert org env vars
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    let varsToUpsert: { key: string; value: string; isSecret: boolean }[];
    if (parsed.data.vars) {
      varsToUpsert = parsed.data.vars.map((v) => ({ key: v.key, value: v.value, isSecret: v.isSecret }));
    } else {
      varsToUpsert = parseEnvContent(parsed.data.content!).map((e) => ({ key: e.key, value: e.value, isSecret: false }));
    }

    if (varsToUpsert.length === 0) {
      return NextResponse.json({ created: 0, updated: 0 });
    }

    // Fetch existing rows including isSecret so we can:
    // 1. Preserve the secret flag for vars updated via .env file content (isSecret: false default)
    // 2. Detect the masked sentinel "••••••••" and skip the value update for secret vars
    const existing = await db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, orgId),
      columns: { id: true, key: true, isSecret: true },
    });
    const existingByKey = new Map(existing.map((v) => [v.key, { id: v.id, isSecret: v.isSecret ?? false }]));

    // The masked sentinel returned by GET for secret vars — never store this string
    const SECRET_SENTINEL = "••••••••";

    let created = 0;
    let updated = 0;

    await db.transaction(async (tx) => {
      for (const v of varsToUpsert) {
        const existingRow = existingByKey.get(v.key);
        if (existingRow) {
          // Preserve the persisted isSecret flag — the client may not know it
          // (e.g. bulk .env upload hardcodes isSecret: false for all parsed vars).
          const effectiveIsSecret = existingRow.isSecret;

          // Skip value update if the client sent back the masked sentinel for a
          // secret var — storing the sentinel would corrupt the encrypted value.
          if (effectiveIsSecret && v.value === SECRET_SENTINEL) {
            updated++; // count as updated (no-op) so the response is accurate
            continue;
          }

          const valueToStore = effectiveIsSecret ? encrypt(v.value, orgId) : v.value;
          await tx.update(orgEnvVars)
            .set({ value: valueToStore, updatedAt: new Date() })
            .where(and(eq(orgEnvVars.id, existingRow.id), eq(orgEnvVars.organizationId, orgId)));
          updated++;
        } else {
          const valueToStore = v.isSecret ? encrypt(v.value, orgId) : v.value;
          await tx.insert(orgEnvVars).values({ id: nanoid(), organizationId: orgId, key: v.key, value: valueToStore, isSecret: v.isSecret });
          created++;
        }
      }
    });

    return NextResponse.json({ created, updated });
  } catch (error) {
    return handleRouteError(error);
  }
}

// DELETE — delete org env var
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await request.json();
    const [deleted] = await db.delete(orgEnvVars)
      .where(and(eq(orgEnvVars.id, id), eq(orgEnvVars.organizationId, orgId)))
      .returning({ id: orgEnvVars.id });

    if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
