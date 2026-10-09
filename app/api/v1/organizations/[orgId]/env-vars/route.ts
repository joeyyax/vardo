import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { orgEnvVars } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { parseEnvContent } from "@/lib/env/parse-env-content";
import { encrypt, decryptOrFallback } from "@/lib/crypto/encrypt";
import { SECRET_MASK } from "@/lib/env/org-env-content";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { can } from "@/lib/auth/permissions";
import { recordActivity } from "@/lib/activity";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createSchema = z.object({
  key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z.string(),
  description: z.string().optional(),
  isSecret: z.boolean().default(false),
}).strict();

const bulkSchema = z.object({
  content: z.string().optional(),
  vars: z.array(z.object({
    key: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    value: z.string(),
    description: z.string().optional(),
    isSecret: z.boolean().default(false),
  })).optional(),
}).strict().refine((d) => d.content !== undefined || d.vars !== undefined, {
  message: "Either content or vars required",
});

// GET — list org env vars, secret values masked unless `reveal=true` for env.reveal holders
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "env.read");
    if (!org) return apiError.forbidden();

    const reveal = request.nextUrl.searchParams.get("reveal") === "true";
    if (reveal && !can(org.membership.role, "env.reveal")) return apiError.forbidden();
    if (reveal) {
      recordActivity({
        organizationId: orgId,
        action: "org.env_revealed",
        userId: org.session.user.id,
      }).catch(() => {});
    }

    const vars = await db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, orgId),
    });

    const safe = vars.map((v) => ({
      ...v,
      value: v.isSecret && !reveal ? SECRET_MASK : decryptOrFallback(v.value, orgId).content,
    }));

    return NextResponse.json({ envVars: safe });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST — create single org env var
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "env.write");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const [created] = await db.insert(orgEnvVars).values({
      id: nanoid(),
      organizationId: orgId,
      key: parsed.data.key,
      value: encrypt(parsed.data.value, orgId),
      description: parsed.data.description,
      isSecret: parsed.data.isSecret,
    }).returning();

    return NextResponse.json(
      { envVar: { ...created, value: created.isSecret ? SECRET_MASK : parsed.data.value } },
      { status: 201 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "Variable already exists" }, { status: 409 });
    }
    return handleRouteError(error);
  }
}

// PUT — bulk upsert org env vars. Keys left out are kept.
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "env.write");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
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

    const existing = await db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, orgId),
      columns: { id: true, key: true, value: true, isSecret: true },
    });
    const existingByKey = new Map(existing.map((v) => [v.key, v]));

    let created = 0;
    let updated = 0;

    // Every value is encrypted at rest; isSecret only controls masking.
    await db.transaction(async (tx) => {
      for (const v of varsToUpsert) {
        const row = existingByKey.get(v.key);
        if (row) {
          // A masked value, or a blank secret, means the editor never saw the stored one.
          if (v.value === SECRET_MASK || (row.isSecret && v.value === "")) continue;

          const current = decryptOrFallback(row.value, orgId);
          if (current.wasEncrypted && !current.decryptFailed && current.content === v.value) continue;

          await tx.update(orgEnvVars)
            .set({ value: encrypt(v.value, orgId), updatedAt: new Date() })
            .where(and(eq(orgEnvVars.id, row.id), eq(orgEnvVars.organizationId, orgId)));
          updated++;
        } else {
          if (v.value === SECRET_MASK) continue;
          await tx.insert(orgEnvVars).values({
            id: nanoid(),
            organizationId: orgId,
            key: v.key,
            value: encrypt(v.value, orgId),
            isSecret: v.isSecret,
          });
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
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "env.write");
    if (!org) return apiError.forbidden();

    const { id } = await request.json();
    const [deleted] = await db.delete(orgEnvVars)
      .where(and(eq(orgEnvVars.id, id), eq(orgEnvVars.organizationId, orgId)))
      .returning({ id: orgEnvVars.id });

    if (!deleted) return apiError.notFound("variable");
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-env-vars" });
export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "organizations-env-vars" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-env-vars" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/env-vars" });
