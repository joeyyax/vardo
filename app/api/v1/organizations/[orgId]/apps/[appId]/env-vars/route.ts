import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { envVars, apps } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { parseEnvContent } from "@/lib/env/parse-env-content";
import { verifyAppAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const createEnvVarSchema = z.object({
  key: z
    .string()
    .min(1, "Key is required")
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid variable name"),
  value: z.string(),
  isSecret: z.boolean().default(true),
});

const updateEnvVarSchema = z.object({
  id: z.string().min(1),
  value: z.string(),
});

const deleteEnvVarSchema = z.object({
  id: z.string().min(1),
});

const bulkEnvVarSchema = z.object({
  key: z
    .string()
    .min(1, "Key is required")
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid variable name"),
  value: z.string(),
  isSecret: z.boolean().default(true),
});

const bulkUpsertSchema = z
  .object({
    content: z.string().optional(),
    vars: z.array(bulkEnvVarSchema).optional(),
    environmentId: z.string().optional(),
  })
  .refine((data) => data.content !== undefined || data.vars !== undefined, {
    message: "Either 'content' or 'vars' must be provided",
  });

// GET /api/v1/organizations/[orgId]/apps/[appId]/env-vars
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const environmentId = request.nextUrl.searchParams.get("environmentId");
    const merged = request.nextUrl.searchParams.get("merged") === "true";
    const reveal = request.nextUrl.searchParams.get("reveal") === "true";

    let vars;

    if (environmentId && merged) {
      const [baseVars, envSpecificVars] = await Promise.all([
        db.query.envVars.findMany({
          where: and(
            eq(envVars.appId, appId),
            isNull(envVars.environmentId)
          ),
        }),
        db.query.envVars.findMany({
          where: and(
            eq(envVars.appId, appId),
            eq(envVars.environmentId, environmentId)
          ),
        }),
      ]);

      const mergedMap = new Map<string, (typeof baseVars)[number]>();
      for (const v of baseVars) mergedMap.set(v.key, v);
      for (const v of envSpecificVars) mergedMap.set(v.key, v);
      vars = Array.from(mergedMap.values());
    } else if (environmentId) {
      vars = await db.query.envVars.findMany({
        where: and(
          eq(envVars.appId, appId),
          eq(envVars.environmentId, environmentId)
        ),
      });
    } else {
      // Default: base vars only (no environment-specific overrides)
      vars = await db.query.envVars.findMany({
        where: and(
          eq(envVars.appId, appId),
          isNull(envVars.environmentId)
        ),
      });
    }

    // Mask secret values unless explicitly revealed
    if (!reveal) {
      vars = vars.map((v) => ({
        ...v,
        value: v.isSecret ? "••••••••" : v.value,
      }));
    }

    return NextResponse.json({ envVars: vars });
  } catch (error) {
    return handleRouteError(error, "Error fetching env vars");
  }
}

// POST /api/v1/organizations/[orgId]/apps/[appId]/env-vars
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = createEnvVarSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [created] = await db
      .insert(envVars)
      .values({
        id: nanoid(),
        appId,
        key: parsed.data.key,
        value: parsed.data.value,
        isSecret: parsed.data.isSecret,
      })
      .returning({
        id: envVars.id,
        key: envVars.key,
        isSecret: envVars.isSecret,
        createdAt: envVars.createdAt,
        updatedAt: envVars.updatedAt,
      });

    return NextResponse.json({ envVar: created }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "A variable with this key already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating env var");
  }
}

// PATCH /api/v1/organizations/[orgId]/apps/[appId]/env-vars
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = updateEnvVarSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(envVars)
      .set({ value: parsed.data.value, updatedAt: new Date() })
      .where(
        and(
          eq(envVars.id, parsed.data.id),
          eq(envVars.appId, appId)
        )
      )
      .returning({
        id: envVars.id,
        key: envVars.key,
        isSecret: envVars.isSecret,
        createdAt: envVars.createdAt,
        updatedAt: envVars.updatedAt,
      });

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ envVar: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating env var");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/env-vars
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = deleteEnvVarSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [deleted] = await db
      .delete(envVars)
      .where(
        and(
          eq(envVars.id, parsed.data.id),
          eq(envVars.appId, appId)
        )
      )
      .returning({ id: envVars.id });

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting env var");
  }
}

// PUT /api/v1/organizations/[orgId]/apps/[appId]/env-vars
// Bulk upsert env vars from raw .env content or structured array
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = bulkUpsertSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Normalize input into a consistent format
    let varsToUpsert: { key: string; value: string; isSecret: boolean }[];

    if (parsed.data.vars) {
      varsToUpsert = parsed.data.vars.map((v) => ({
        key: v.key,
        value: v.value,
        isSecret: v.isSecret,
      }));
    } else {
      const envEntries = parseEnvContent(parsed.data.content!);
      varsToUpsert = envEntries.map((entry) => ({
        key: entry.key,
        value: entry.value,
        isSecret: true, // Default to secret for parsed content
      }));
    }

    const envId = parsed.data.environmentId || null;

    // Fetch existing vars for this app (scoped to environment if provided)
    const existingConditions = envId
      ? and(eq(envVars.appId, appId), eq(envVars.environmentId, envId))
      : eq(envVars.appId, appId);

    const existingVars = await db.query.envVars.findMany({
      where: existingConditions,
      columns: { id: true, key: true },
    });

    const existingByKey = new Map(existingVars.map((v) => [v.key, v.id]));
    const incomingKeys = new Set(varsToUpsert.map((v) => v.key));

    let created = 0;
    let updated = 0;
    let deleted = 0;

    await db.transaction(async (tx) => {
      // Upsert incoming vars
      for (const v of varsToUpsert) {
        const existingId = existingByKey.get(v.key);

        if (existingId) {
          await tx
            .update(envVars)
            .set({
              value: v.value,
              isSecret: v.isSecret,
              updatedAt: new Date(),
            })
            .where(
              and(eq(envVars.id, existingId), eq(envVars.appId, appId))
            );
          updated++;
        } else {
          await tx.insert(envVars).values({
            id: nanoid(),
            appId,
            key: v.key,
            value: v.value,
            isSecret: v.isSecret,
            environmentId: envId,
          });
          created++;
        }
      }

      // Delete vars that were removed from the editor
      for (const [key, id] of existingByKey) {
        if (!incomingKeys.has(key)) {
          await tx.delete(envVars).where(
            and(eq(envVars.id, id), eq(envVars.appId, appId))
          );
          deleted++;
        }
      }
    });

    // Flag app as needing a redeploy to pick up changes
    if (created > 0 || updated > 0 || deleted > 0) {
      await db
        .update(apps)
        .set({ needsRedeploy: true, updatedAt: new Date() })
        .where(eq(apps.id, appId));
    }

    return NextResponse.json({ created, updated, deleted });
  } catch (error) {
    return handleRouteError(error, "Error bulk upserting env vars");
  }
}
