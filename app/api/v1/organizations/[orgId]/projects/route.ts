import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { actorForOrg } from "@/lib/app-services/session-actor";
import { createProject, createProjectSchema, listProjects } from "@/lib/app-services/projects";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects
// Lists projects (groups) in the org with their apps
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const actor = await actorForOrg(orgId);
    if (!actor) return apiError.forbidden();

    return NextResponse.json({ projects: await listProjects(actor) });
  } catch (error) {
    return handleRouteError(error, "Error fetching projects");
  }
}

// POST /api/v1/organizations/[orgId]/projects
// Creates a new project (group) with name, displayName, color, description
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const actor = await actorForOrg(orgId);
    if (!actor) return apiError.forbidden();

    const parsed = createProjectSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const project = await createProject(actor, parsed.data);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating project");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-projects" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/projects" });
