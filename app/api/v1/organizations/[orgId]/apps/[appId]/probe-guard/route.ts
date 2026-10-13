import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyAppAccess, verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity";
import { appProbeGuardSchema, normalizeAppProbeGuard } from "@/lib/probe-guard/settings";
import { appLooksLikeWordPress, appServesOwnRobots, guardOverview } from "@/lib/probe-guard/overview";
import { syncGuardFile } from "@/lib/probe-guard/sync";
import { pendingSuggestion } from "@/lib/probe-guard/suggestions";
import { getProbeGuardSettings, guardKey } from "@/lib/probe-guard/instance";
import { isAppAdmin } from "@/lib/auth/admin";

type RouteParams = { params: Promise<{ orgId: string; appId: string }> };

async function readGuard(appId: string, orgId: string) {
  const row = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { probeGuard: true, parentAppId: true },
  });
  return row;
}

/** GET — the app's probe guard setting, this week's counts and its active bans. */
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.view");
    if (!app) return apiError.forbidden();
    const row = await readGuard(appId, orgId);
    if (!row) return apiError.notFound("app");
    const [overview, looksLikeWordPress, instance, admin] = await Promise.all([
      guardOverview(appId),
      appLooksLikeWordPress(appId),
      getProbeGuardSettings(),
      isAppAdmin().catch(() => false),
    ]);
    const settings = normalizeAppProbeGuard(row.probeGuard);
    return NextResponse.json({
      settings,
      suggestion: pendingSuggestion(settings, looksLikeWordPress),
      available: guardKey() !== null,
      traps: instance.traps.enabled ? instance.traps.paths : [],
      canBanPermanently: admin,
      ...overview,
    });
  } catch (error) {
    return handleRouteError(error, "Error reading the probe guard");
  }
}

/** PUT — saves the setting and rewrites the guard file, so it applies without a redeploy. */
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.config");
    if (!org) return apiError.forbidden();
    const row = await readGuard(appId, orgId);
    if (!row) return apiError.notFound("app");
    if (row.parentAppId) return NextResponse.json({ error: "Set this on the compose app, not a service." }, { status: 400 });

    const parsed = appProbeGuardSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    const next = parsed.data;
    const current = normalizeAppProbeGuard(row.probeGuard);

    if (next.robotsTxt && !current.robotsTxt && (await appServesOwnRobots(appId))) {
      return NextResponse.json({ error: "This app serves its own robots.txt, so Vardo leaves it alone." }, { status: 409 });
    }

    await db.update(apps).set({ probeGuard: next, updatedAt: new Date() }).where(eq(apps.id, appId));
    const applied = await syncGuardFile().catch(() => "skipped" as const);

    recordActivity({
      organizationId: orgId,
      action: "app.updated",
      appId,
      userId: org.session.user.id,
      metadata: { changes: ["probeGuard"] },
    }).catch(() => {});

    return NextResponse.json({ settings: next, applied: applied === "skipped" ? "pending" : "live" });
  } catch (error) {
    return handleRouteError(error, "Error saving the probe guard");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/probe-guard" });
export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "put:v1/organizations/*/apps/*/probe-guard" });
