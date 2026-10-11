import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { abuseSettingsBodySchema } from "@/lib/probe-guard/abuse-settings";
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

/** POST — saves settings and, when sent, a new key. */
async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const parsed = abuseSettingsBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    const { settings, apiKey } = parsed.data;
    const key = apiKey === undefined ? await getAbuseApiKey() : apiKey;
    if (!key && (settings.reporting.enabled || settings.blocklists.abuseipdb.enabled)) {
      return NextResponse.json({ error: "Add an AbuseIPDB API key first." }, { status: 400 });
    }
    if (apiKey !== undefined) await setAbuseApiKey(apiKey);
    const before = await getAbuseSettings();
    await setAbuseSettings(settings);
    // Turning a blocklist off takes effect now rather than at the next import pass.
    if (before.blocklists.abuseipdb.enabled && !settings.blocklists.abuseipdb.enabled) await clearBlocklistBans().catch(() => {});
    if (before.blocklists.spamhaus.enabled !== settings.blocklists.spamhaus.enabled) await syncGuardFile().catch(() => {});
    return NextResponse.json({ ok: true, settings, apiKey: maskApiKey(key) });
  } catch (error) {
    return handleRouteError(error, "Error saving abuse reporting settings");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/probe-guard/abuse" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-probe-guard-abuse" });
