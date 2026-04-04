import { NextRequest, NextResponse } from "next/server";
import { handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects, groupEnvironments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

const createEnvSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Name must be lowercase alphanumeric with hyphens"),
  type: z.enum(["staging", "preview"]).default("staging"),
}).strict();

// GET /api/v1/organizations/[orgId]/projects/[projectId]/environments
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const envs = await db.query.groupEnvironments.findMany({
      where: eq(groupEnvironments.projectId, projectId),
    });

    return NextResponse.json({ environments: envs });
  } catch (error) {
    return handleRouteError(error, "Error fetching project environments");
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/environments
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = createEnvSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [env] = await db
      .insert(groupEnvironments)
      .values({
        id: nanoid(),
        projectId,
        name: parsed.data.name,
        type: parsed.data.type,
        createdBy: org.session.user.id,
      })
      .returning();

    return NextResponse.json({ environment: env }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "An environment with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating project environment");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "projects-environments" });
