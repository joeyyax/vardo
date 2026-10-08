import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { environments, envVars, apps, groupEnvironments } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { HOSTNAME_RE } from "@/lib/security/hostname";
import { createGroupEnvironment } from "@/lib/docker/clone";
import { snapshotIntoEnvironment } from "@/lib/docker/environment-env";
import { verifyAppAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";
import { gitBranchUpdateSchema } from "@/lib/api/git-fields";
import { findPrefixOwnerForApp, prefixCollisionMessage } from "@/lib/docker/volume-prefix";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/environments
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.view");

    if (!app) {
      return apiError.notFound("app");
    }

    const envs = await db.query.environments.findMany({
      where: eq(environments.appId, appId),
    });

    const varCounts = await db
      .select({
        environmentId: envVars.environmentId,
        count: sql<number>`count(*)::int`,
      })
      .from(envVars)
      .where(eq(envVars.appId, appId))
      .groupBy(envVars.environmentId);

    const countMap = new Map(
      varCounts.map((v) => [v.environmentId, v.count])
    );

    // Vars with no environment.
    const nullCount = countMap.get(null) ?? 0;

    const result = envs.map((env) => ({
      ...env,
      envVarCount: countMap.get(env.id) ?? 0,
    }));

    // Apps in a project include group environments.
    const appRecord = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
      columns: { projectId: true },
    });

    let groupEnvs: typeof groupEnvironments.$inferSelect[] = [];
    if (appRecord?.projectId) {
      groupEnvs = await db.query.groupEnvironments.findMany({
        where: eq(groupEnvironments.projectId, appRecord.projectId),
        with: {
          environments: {
            columns: {
              id: true,
              appId: true,
              name: true,
              type: true,
              domain: true,
            },
          },
        },
      });
    }

    return NextResponse.json({
      environments: result,
      unassignedVarCount: nullCount,
      ...(groupEnvs.length > 0 ? { groupEnvironments: groupEnvs } : {}),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching environments");
  }
}

const createEnvironmentSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "Name must be lowercase alphanumeric with hyphens, and can't start or end with a hyphen"
    ),
  type: z.enum(["production", "staging", "preview", "local"]),
  domain: z.union([z.literal(""), z.string().regex(HOSTNAME_RE, "Invalid domain name")]).optional(),
  cloneFrom: z.string().optional(), // environment ID to clone env vars from
  gitBranch: gitBranchUpdateSchema.optional(), // override git branch for this environment
  appOverrides: z
    .record(
      z.string(),
      z.object({
        strategy: z.enum(["clone", "clone_data", "empty", "skip"]).optional(),
        gitBranch: gitBranchUpdateSchema.optional(),
      })
    )
    .optional(),
}).strict();

// POST /api/v1/organizations/[orgId]/apps/[appId]/environments
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("environments");
    if (gate) return gate;

    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.config");

    if (!app) {
      return apiError.notFound("app");
    }

    const body = await request.json();
    const parsed = createEnvironmentSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    if (parsed.data.type === "preview") {
      const previewGate = await requirePlugin("previews");
      if (previewGate) return previewGate;
    }

    // Apps in a project get a group environment.
    const appRecord = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
      columns: { projectId: true },
    });

    if (appRecord?.projectId) {
      if (parsed.data.type === "production") {
        return NextResponse.json(
          { error: "Can't create additional production environments for a grouped app" },
          { status: 400 }
        );
      }

      const orgAccess = await verifyOrgAccess(orgId, "app.config");
      if (!orgAccess) return apiError.forbidden();
      const result = await createGroupEnvironment({
        projectId: appRecord.projectId,
        organizationId: orgId,
        name: parsed.data.name,
        type: parsed.data.type as "staging" | "preview",
        appOverrides: parsed.data.appOverrides,
        createdBy: orgAccess.session.user.id,
      });

      return NextResponse.json(result, { status: 201 });
    }

    // The first environment is the default.
    {
      const owner = await findPrefixOwnerForApp(appId, parsed.data.name);
      if (owner) return NextResponse.json({ error: prefixCollisionMessage(owner) }, { status: 409 });
    }

    const existingCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(environments)
      .where(eq(environments.appId, appId));

    const isFirst = (existingCount[0]?.count ?? 0) === 0;

    const envId = nanoid();
    const [created] = await db
      .insert(environments)
      .values({
        id: envId,
        appId,
        name: parsed.data.name,
        type: parsed.data.type,
        domain: parsed.data.domain || null,
        gitBranch: parsed.data.gitBranch || null,
        isDefault: isFirst,
        clonedFromId: parsed.data.cloneFrom || null,
      })
      .returning();

    if (parsed.data.cloneFrom) {
      const sourceVars = await db.query.envVars.findMany({
        where: and(
          eq(envVars.appId, appId),
          eq(envVars.environmentId, parsed.data.cloneFrom),
        ),
      });

      // Cloning production includes base vars.
      const sourceEnv = await db.query.environments.findFirst({
        where: and(
          eq(environments.id, parsed.data.cloneFrom),
          eq(environments.appId, appId),
        ),
        columns: { type: true },
      });
      if (sourceEnv?.type === "production") {
        const baseVars = await db.query.envVars.findMany({
          where: and(
            eq(envVars.appId, appId),
            sql`${envVars.environmentId} IS NULL`,
          ),
        });
        // Base vars first so env-specific ones override.
        const merged = new Map<string, typeof sourceVars[0]>();
        for (const v of baseVars) merged.set(v.key, v);
        for (const v of sourceVars) merged.set(v.key, v);
        const allVars = Array.from(merged.values());

        if (allVars.length > 0) {
          await db.insert(envVars).values(
            allVars.map((v) => ({
              id: nanoid(),
              appId,
              key: v.key,
              value: v.value,
              environmentId: envId,
              isSecret: v.isSecret,
            }))
          );
        }
      } else if (sourceVars.length > 0) {
        await db.insert(envVars).values(
          sourceVars.map((v) => ({
            id: nanoid(),
            appId,
            key: v.key,
            value: v.value,
            environmentId: envId,
            isSecret: v.isSecret,
          }))
        );
      }
    }

    if (!created.isDefault) {
      await snapshotIntoEnvironment({
        appId,
        organizationId: orgId,
        environmentId: envId,
        domain: created.domain,
        sourceEnvironmentId: parsed.data.cloneFrom,
      });
    }

    return NextResponse.json({ environment: created }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "An environment with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating environment");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/environments
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.config");

    if (!app) {
      return apiError.notFound("app");
    }

    const body = await request.json();
    const { environmentId } = body;

    if (!environmentId) {
      return NextResponse.json(
        { error: "environmentId is required" },
        { status: 400 }
      );
    }

    const env = await db.query.environments.findFirst({
      where: and(
        eq(environments.id, environmentId),
        eq(environments.appId, appId),
      ),
    });

    if (!env) {
      return NextResponse.json({ error: "Environment not found" }, { status: 404 });
    }

    if (env.type === "production") {
      return NextResponse.json(
        { error: "Can't delete the production environment" },
        { status: 400 }
      );
    }

    // Cascades to env vars.
    await db
      .delete(environments)
      .where(eq(environments.id, environmentId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting environment");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-environments" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-environments" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/environments" });
