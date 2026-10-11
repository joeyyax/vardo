// Checks every 15 minutes whether a blocklist is due; each source is fetched about once a day.

import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { applyBlocklistBans, clearBlocklistBans, neverBanContext } from "../bans";
import { getAbuseApiKey, getAbuseSettings, getAbuseStatus, setDropRanges, updateAbuseStatus } from "../abuse-store";
import { syncGuardFile } from "../sync";
import { runBlocklistPass } from "./import";
import { blocklistProviders } from "./registry";

const log = logger.child("probe-guard");

export const blocklistLoop = new IntervalLoop({
  name: "probe-guard-blocklist",
  intervalMs: 15 * 60_000,
  firstRunMs: 60_000,
  log,
  run: async () => {
    const result = await runBlocklistPass({
      providers: blocklistProviders(),
      settings: getAbuseSettings,
      apiKey: getAbuseApiKey,
      status: getAbuseStatus,
      setSource: (id, status) => updateAbuseStatus((s) => ({ ...s, blocklists: { ...s.blocklists, [id]: status } })),
      neverBanContext,
      applyAddresses: (entries) => applyBlocklistBans(entries),
      clearAddresses: clearBlocklistBans,
      setRanges: async (ranges) => {
        await setDropRanges({ ranges, fetchedAt: ranges.length > 0 ? new Date().toISOString() : null });
        await syncGuardFile().catch((err) => log.warn("Couldn't write the probe guard file:", err));
      },
    });
    for (const [id, outcome] of Object.entries(result)) {
      if (outcome === "fetched" || outcome === "cleared") log.info(`Blocklist ${id}: ${outcome}`);
      if (outcome === "failed") log.warn(`Blocklist ${id}: fetch failed`);
    }
  },
});
