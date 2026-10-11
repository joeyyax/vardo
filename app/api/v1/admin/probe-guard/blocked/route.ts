import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { blockedSummary } from "@/lib/probe-guard/blocked";
import { getAbuseSettings, getAbuseStatus } from "@/lib/probe-guard/abuse-store";
import { blocklistBanCount } from "@/lib/probe-guard/bans";
import { activeBannedRanges, enforcedBlocklistBans } from "@/lib/probe-guard/sync";

/** GET — blocked requests per source over 30 days, and how much of each blocklist showed up. */
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const [summary, settings, status, abuseIpdbListed, abuseIpdbEnforced, ranges] = await Promise.all([
      blockedSummary(),
      getAbuseSettings(),
      getAbuseStatus(),
      blocklistBanCount().catch(() => 0),
      enforcedBlocklistBans().catch(() => 0),
      activeBannedRanges().catch(() => []),
    ]);
    return NextResponse.json({
      ...summary,
      enabled: { abuseipdb: settings.blocklists.abuseipdb.enabled, spamhaus: settings.blocklists.spamhaus.enabled },
      imported: { abuseipdb: abuseIpdbListed, spamhaus: status.blocklists.spamhaus.count },
      enforced: { abuseipdb: abuseIpdbEnforced, spamhaus: ranges.length },
    });
  } catch (error) {
    return handleRouteError(error, "Error reading blocked counts");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/probe-guard/blocked" });
