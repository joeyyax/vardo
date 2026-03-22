import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { environments, envVars, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

async function verifyProjectAccess(orgId: string, projectId: string) {
  const { organization } = await requireOrg();

  if (organization.id !== orgId) {
    return null;
  }

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.organizationId, orgId)
    ),
    columns: { id: true },
  });

  return project;
}

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

    return NextResponse.json({
      environments: result,
      unassignedVarCount: nullCount,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching environments:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
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

    // Check if this is the first environment — make it default
    const existingCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(environments)
      .where(eq(environments.projectId, projectId));

    const isFirst = (existingCount[0]?.count ?? 0) === 0;

    const [created] = await db
      .insert(environments)
      .values({
        id: nanoid(),
        projectId,
        name: parsed.data.name,
        type: parsed.data.type,
        domain: parsed.data.domain || null,
        isDefault: isFirst,
      })
      .returning();

    return NextResponse.json({ environment: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "An environment with this name already exists" },
        { status: 409 }
      );
    }
    console.error("Error creating environment:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
