import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess, verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity";
import { liftBan } from "@/lib/probe-guard/bans";

type RouteParams = { params: Promise<{ orgId: string; appId: string; banId: string }> };

/** DELETE — lifts one of this app's bans now. */
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, banId } = await params;
    const org = await verifyOrgAccess(orgId, "app.config");
    if (!org) return apiError.forbidden();
    const app = await verifyAppAccess(orgId, appId, "app.config");
    if (!app) return apiError.forbidden();
    if (!(await liftBan(banId, org.session.user.id, { appId }))) return apiError.notFound("ban");
    recordActivity({ organizationId: orgId, action: "security.probe_unban", appId, userId: org.session.user.id }).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error lifting a ban");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "delete:v1/organizations/*/apps/*/probe-guard/bans/*" });
