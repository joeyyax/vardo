import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess, verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity";
import { isAppAdmin } from "@/lib/auth/admin";
import { banAgain, liftBan, makeBanPermanent } from "@/lib/probe-guard/bans";
import { banPatchSchema } from "@/lib/probe-guard/settings";
import { banAgainResponse } from "@/lib/probe-guard/ban-again-response";

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

/** PATCH — bans an old ban's address again, or makes a ban permanent (instance admins only). */
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, banId } = await params;
    const org = await verifyOrgAccess(orgId, "app.config");
    if (!org) return apiError.forbidden();
    const app = await verifyAppAccess(orgId, appId, "app.config");
    if (!app) return apiError.forbidden();
    const parsed = banPatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    if ("again" in parsed.data) return banAgainResponse(await banAgain(banId, { appId }));
    if (!(await isAppAdmin())) return apiError.forbidden();
    if (!(await makeBanPermanent(banId, org.session.user.id, { appId }))) return apiError.notFound("ban");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error changing a ban");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "patch:v1/organizations/*/apps/*/probe-guard/bans/*" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "delete:v1/organizations/*/apps/*/probe-guard/bans/*" });
