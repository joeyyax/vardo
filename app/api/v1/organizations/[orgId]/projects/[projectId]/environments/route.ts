import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { environments, envVars, projects, groupEnvironments } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createGroupEnvironment } from "@/lib/docker/clone";
import { verifyProjectAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/environments
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Fetch environments with env var counts
    const envs = await db.query.environments.findMany({
      where: eq(environments.projectId, projectId),
    });

    // Get env var counts per environment
    const varCounts = await db
      .select({
        environmentId: envVars.environmentId,
        count: sql<number>`count(*)::int`,
      })
      .from(envVars)
      .where(eq(envVars.projectId, projectId))
      .groupBy(envVars.environmentId);

    const countMap = new Map(
      varCounts.map((v) => [v.environmentId, v.count])
    );

    // Also count vars with no environment (null)
    const nullCount = countMap.get(null) ?? 0;

    const result = envs.map((env) => ({
      ...env,
      envVarCount: countMap.get(env.id) ?? 0,
    }));

    // Check if project has children (is a parent) — if so, include group environments
    const firstChild = await db.query.projects.findFirst({
      where: eq(projects.parentId, projectId),
      columns: { id: true },
    });

    let groupEnvs: typeof groupEnvironments.$inferSelect[] = [];
    if (firstChild) {
      groupEnvs = await db.query.groupEnvironments.findMany({
        where: eq(groupEnvironments.parentProjectId, projectId),
        with: {
          environments: {
            columns: {
              id: true,
              projectId: true,
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
      "Name must be lowercase alphanumeric with hyphens, and cannot start or end with a hyphen"
    ),
  type: z.enum(["production", "staging", "preview"]),
  domain: z.string().optional(),
  cloneFrom: z.string().optional(), // environment ID to clone env vars from
  gitBranch: z.string().optional(), // override git branch for this environment
  parentProjectOverrides: z
    .record(
      z.string(),
      z.object({
        strategy: z.enum(["clone", "clone_data", "empty", "skip"]).optional(),
        gitBranch: z.string().optional(),
      })
    )
    .optional(),
});

// POST /api/v1/organizations/[orgId]/projects/[projectId]/environments
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = createEnvironmentSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Check if this project has children (is a parent) — if so, create a group environment
    const firstChild = await db.query.projects.findFirst({
      where: eq(projects.parentId, projectId),
      columns: { id: true },
    });

    if (firstChild) {
      if (parsed.data.type === "production") {
        return NextResponse.json(
          { error: "Cannot create additional production environments for a parent project" },
          { status: 400 }
        );
      }

      const { organization: _org, session: sess } = await requireOrg();
      const result = await createGroupEnvironment({
        parentProjectId: projectId,
        organizationId: orgId,
        name: parsed.data.name,
        type: parsed.data.type as "staging" | "preview",
        projectOverrides: parsed.data.parentProjectOverrides,
        createdBy: sess.user.id,
      });

      return NextResponse.json(result, { status: 201 });
    }

    // Check if this is the first environment — make it default
    const existingCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(environments)
      .where(eq(environments.projectId, projectId));

    const isFirst = (existingCount[0]?.count ?? 0) === 0;

    const envId = nanoid();
    const [created] = await db
      .insert(environments)
      .values({
        id: envId,
        projectId,
        name: parsed.data.name,
        type: parsed.data.type,
        domain: parsed.data.domain || null,
        gitBranch: parsed.data.gitBranch || null,
        isDefault: isFirst,
        clonedFromId: parsed.data.cloneFrom || null,
      })
      .returning();

    // Clone env vars from source environment
    if (parsed.data.cloneFrom) {
      const sourceVars = await db.query.envVars.findMany({
        where: and(
          eq(envVars.projectId, projectId),
          eq(envVars.environmentId, parsed.data.cloneFrom),
        ),
      });

      // Also include base vars (environmentId IS NULL) if cloning from production
      const sourceEnv = await db.query.environments.findFirst({
        where: eq(environments.id, parsed.data.cloneFrom),
        columns: { type: true },
      });
      if (sourceEnv?.type === "production") {
        const baseVars = await db.query.envVars.findMany({
          where: and(
            eq(envVars.projectId, projectId),
            sql`${envVars.environmentId} IS NULL`,
          ),
        });
        // Base vars first, env-specific override
        const merged = new Map<string, typeof sourceVars[0]>();
        for (const v of baseVars) merged.set(v.key, v);
        for (const v of sourceVars) merged.set(v.key, v);
        const allVars = Array.from(merged.values());

        if (allVars.length > 0) {
          await db.insert(envVars).values(
            allVars.map((v) => ({
              id: nanoid(),
              projectId,
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
            projectId,
            key: v.key,
            value: v.value,
            environmentId: envId,
            isSecret: v.isSecret,
          }))
        );
      }
    }

    return NextResponse.json({ environment: created }, { status: 201 });
  } catch (error) {
    const pgCode = error instanceof Error
      ? ("code" in error ? (error as { code: string }).code : null) ??
        (error.cause && typeof error.cause === "object" && "code" in error.cause ? (error.cause as { code: string }).code : null)
      : null;
    if (pgCode === "23505") {
      return NextResponse.json(
        { error: "An environment with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating environment");
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/environments
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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
        eq(environments.projectId, projectId),
      ),
    });

    if (!env) {
      return NextResponse.json({ error: "Environment not found" }, { status: 404 });
    }

    if (env.type === "production") {
      return NextResponse.json(
        { error: "Cannot delete the production environment" },
        { status: 400 }
      );
    }

    // Delete the environment (cascades to env vars via FK)
    await db
      .delete(environments)
      .where(eq(environments.id, environmentId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting environment");
  }
}
