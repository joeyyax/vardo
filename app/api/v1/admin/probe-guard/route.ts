import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getProbeGuardSettings, guardKey, setProbeGuardSettings } from "@/lib/probe-guard/instance";
import { instanceProbeGuardPartialSchema, instanceProbeGuardSchema, mergeInstanceProbeGuard } from "@/lib/probe-guard/settings";
import { guardOverview } from "@/lib/probe-guard/overview";
import { syncGuardFile } from "@/lib/probe-guard/sync";

/** GET — instance probe guard settings, this week's counts and every active ban. */
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const [settings, overview] = await Promise.all([getProbeGuardSettings(), guardOverview()]);
    const appIds = [...new Set(overview.bans.map((b) => b.appId).filter((id): id is string => !!id))];
    const names = appIds.length
      ? await db.select({ id: apps.id, displayName: apps.displayName }).from(apps).where(inArray(apps.id, appIds))
      : [];
    const nameOf = new Map(names.map((n) => [n.id, n.displayName]));
    return NextResponse.json({
      configured: true,
      settings,
      available: guardKey() !== null,
      stats: overview.stats,
      bans: overview.bans.map((b) => ({ ...b, appName: b.appId ? nameOf.get(b.appId) ?? null : null })),
    });
  } catch (error) {
    return handleRouteError(error, "Error reading probe guard settings");
  }
}

/** POST — saves instance settings and rewrites the guard file. Accepts a partial body; merges over the stored settings. */
async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const parsed = instanceProbeGuardPartialSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    const current = await getProbeGuardSettings();
    const merged = mergeInstanceProbeGuard(current, parsed.data);
    const final = instanceProbeGuardSchema.safeParse(merged);
    if (!final.success) return apiError.validation(final.error, { details: true });
    await setProbeGuardSettings(final.data);
    await syncGuardFile().catch(() => {});
    return NextResponse.json({ ok: true, settings: final.data });
  } catch (error) {
    return handleRouteError(error, "Error saving probe guard settings");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/probe-guard" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-probe-guard" });