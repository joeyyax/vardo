import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { actorForOrg } from "@/lib/app-services/session-actor";
import { listStars, starTarget, unstarTarget } from "@/lib/app-services/stars";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/stars
// The caller's starred projects and apps in this org.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const actor = await actorForOrg(orgId);
    if (!actor) return apiError.forbidden();
    return NextResponse.json(await listStars(actor));
  } catch (error) {
    return handleRouteError(error, "Error fetching stars");
  }
}

// PUT /api/v1/organizations/[orgId]/stars
// Stars { kind, targetId }.
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const actor = await actorForOrg(orgId);
    if (!actor) return apiError.forbidden();
    const star = await starTarget(actor, await request.json().catch(() => null));
    return NextResponse.json({ star, starred: true });
  } catch (error) {
    return handleRouteError(error, "Error starring");
  }
}

// DELETE /api/v1/organizations/[orgId]/stars?kind=&targetId=
// Unstars a project or app.
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const actor = await actorForOrg(orgId);
    if (!actor) return apiError.forbidden();
    const sp = request.nextUrl.searchParams;
    const star = await unstarTarget(actor, { kind: sp.get("kind"), targetId: sp.get("targetId") });
    return NextResponse.json({ star, starred: false });
  } catch (error) {
    return handleRouteError(error, "Error removing star");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/stars" });
export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "organizations-stars" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-stars" });
