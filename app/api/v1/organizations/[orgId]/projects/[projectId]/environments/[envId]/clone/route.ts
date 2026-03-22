import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { environments, envVars, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; envId: string }>;
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

const cloneSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "Name must be lowercase alphanumeric with hyphens"
    ),
  type: z.enum(["production", "staging", "preview"]).optional(),
  domain: z.string().optional(),
});

// POST /api/v1/organizations/[orgId]/projects/[projectId]/environments/[envId]/clone
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, envId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = cloneSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Get the source environment
    const sourceEnv = await db.query.environments.findFirst({
      where: and(
        eq(environments.id, envId),
        eq(environments.projectId, projectId)
      ),
    });

    if (!sourceEnv) {
      return NextResponse.json(
        { error: "Source environment not found" },
        { status: 404 }
      );
    }

    // Get the source environment's env vars
    const sourceVars = await db.query.envVars.findMany({
      where: and(
        eq(envVars.projectId, projectId),
        eq(envVars.environmentId, envId)
      ),
    });

    const newEnvId = nanoid();

    await db.transaction(async (tx) => {
      // Create the new environment
      await tx.insert(environments).values({
        id: newEnvId,
        projectId,
        name: parsed.data.name,
        type: parsed.data.type ?? sourceEnv.type,
        domain: parsed.data.domain || null,
        isDefault: false,
        clonedFromId: envId,
      });

      // Clone env vars
      if (sourceVars.length > 0) {
        await tx.insert(envVars).values(
          sourceVars.map((v) => ({
            id: nanoid(),
            projectId,
            key: v.key,
            value: v.value,
            environmentId: newEnvId,
            isSecret: v.isSecret,
          }))
        );
      }
    });

    const created = await db.query.environments.findFirst({
      where: eq(environments.id, newEnvId),
    });

    return NextResponse.json(
      {
        environment: created,
        clonedVars: sourceVars.length,
      },
      { status: 201 }
    );
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
    console.error("Error cloning environment:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
