import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { abuseSettingsPartialSchema, mergeAbuseSettings, abuseSettingsSchema } from "@/lib/probe-guard/abuse-settings";
import {
  getAbuseApiKey,
  getAbuseSettings,
  getAbuseStatus,
  maskApiKey,
  setAbuseApiKey,
  setAbuseSettings,
} from "@/lib/probe-guard/abuse-store";
import { blocklistBanCount, clearBlocklistBans } from "@/lib/probe-guard/bans";
import { defaultReportStore, reportDay } from "@/lib/probe-guard/reporting/queue";
import { syncGuardFile } from "@/lib/probe-guard/sync";

/** GET — abuse reporting and blocklist settings, the masked key and status. The key itself never leaves the server. */
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const [settings, key, status, blocklistBans, reportedToday] = await Promise.all([
      getAbuseSettings(),
      getAbuseApiKey(),
      getAbuseStatus(),
      blocklistBanCount().catch(() => 0),
      defaultReportStore().then((s) => s.dailyCount(reportDay(Date.now()))).catch(() => 0),
    ]);
    return NextResponse.json({
      configured: true,
      settings,
      apiKey: maskApiKey(key),
      status,
      blocklistBans,
      reportedToday,
    });
  } catch (error) {
    return handleRouteError(error, "Error reading abuse reporting settings");
  }
}

/** POST — saves settings and, when sent, a new key. Settings body is merged over the stored settings. */
async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const raw = await request.json().catch(() => null);
    const apiKeyParsed = z.object({ apiKey: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9]+$/).nullable().optional() }).safeParse(raw);
    if (!apiKeyParsed.success) return apiError.validation(apiKeyParsed.error, { details: true });
    const settingsParsed = abuseSettingsPartialSchema.safeParse(raw);
    if (!settingsParsed.success) return apiError.validation(settingsParsed.error, { details: true });
    const apiKey = apiKeyParsed.data.apiKey;
    const before = await getAbuseSettings();
    const merged = mergeAbuseSettings(before, settingsParsed.data);
    const final = abuseSettingsSchema.safeParse(merged);
    if (!final.success) return apiError.validation(final.error, { details: true });
    const key = apiKey === undefined ? await getAbuseApiKey() : apiKey;
    if (!key && (merged.reporting.enabled || merged.blocklists.abuseipdb.enabled)) {
      return NextResponse.json({ error: "Add an AbuseIPDB API key first." }, { status: 400 });
    }
    if (apiKey !== undefined) await setAbuseApiKey(apiKey);
    await setAbuseSettings(merged);
    // Turning a blocklist off takes effect now rather than at the next import pass.
    if (before.blocklists.abuseipdb.enabled && !merged.blocklists.abuseipdb.enabled) await clearBlocklistBans().catch(() => {});
    if (before.blocklists.spamhaus.enabled !== merged.blocklists.spamhaus.enabled) await syncGuardFile().catch(() => {});
    return NextResponse.json({ ok: true, settings: merged, apiKey: maskApiKey(key) });
  } catch (error) {
    return handleRouteError(error, "Error saving abuse reporting settings");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/probe-guard/abuse" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-probe-guard-abuse" });
