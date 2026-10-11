// Daily blocklist import: fetch each enabled source, drop never-ban entries, apply, and clear sources turned off.

import { neverBanMatcher, rangeNeverBanReason, type NeverBanContext } from "../ban-policy";
import type { AbuseSettings, AbuseStatus, BlocklistSourceStatus } from "../abuse-settings";
import type { BlocklistId, BlocklistProvider } from "./types";

/** A day, less slack so the refresh lands before the 24-hour bans lapse. */
export const REFRESH_MS = 23 * 3_600_000;

export type ImportDeps = {
  providers: readonly BlocklistProvider[];
  settings: () => Promise<AbuseSettings>;
  apiKey: () => Promise<string | null>;
  status: () => Promise<AbuseStatus>;
  setSource: (id: BlocklistId, status: BlocklistSourceStatus) => Promise<void>;
  neverBanContext: () => Promise<NeverBanContext>;
  applyAddresses: (entries: { ip: string; score: number }[]) => Promise<number>;
  clearAddresses: () => Promise<number>;
  setRanges: (ranges: string[]) => Promise<void>;
  now?: () => number;
};

function sourceConfig(id: BlocklistId, settings: AbuseSettings): { enabled: boolean; with: string; minConfidence: number } {
  if (id === "abuseipdb") {
    const s = settings.blocklists.abuseipdb;
    return { enabled: s.enabled, with: `confidence:${s.minConfidence}`, minConfidence: s.minConfidence };
  }
  return { enabled: settings.blocklists.spamhaus.enabled, with: "drop", minConfidence: 0 };
}

/** Whether a source should be fetched now. Never sooner than the source allows after any attempt. */
export function isDue(provider: BlocklistProvider, status: BlocklistSourceStatus, configWith: string, now: number): boolean {
  const attempted = status.attemptedAt ? Date.parse(status.attemptedAt) : 0;
  if (now - attempted < provider.minIntervalMs) return false;
  if (!status.fetchedAt || status.fetchedWith !== configWith) return true;
  return now - Date.parse(status.fetchedAt) >= REFRESH_MS;
}

/** Ranges that may be blocked: valid, deduplicated and clear of every never-ban range, broadest first. */
export function blockableRanges(values: readonly string[], ctx: NeverBanContext): string[] {
  const never = neverBanMatcher(ctx);
  const ok = [...new Set(values)].filter((r) => !rangeNeverBanReason(r, ctx, never));
  return ok.sort((a, b) => Number(a.split("/")[1]) - Number(b.split("/")[1]));
}

export type ImportResult = Partial<Record<BlocklistId, "fetched" | "cleared" | "failed" | "skipped">>;

export async function runBlocklistPass(deps: ImportDeps): Promise<ImportResult> {
  const now = (deps.now ?? Date.now)();
  const [settings, status] = await Promise.all([deps.settings(), deps.status()]);
  const result: ImportResult = {};

  for (const provider of deps.providers) {
    const current = status.blocklists[provider.id];
    const config = sourceConfig(provider.id, settings);

    if (!config.enabled) {
      if (current.count > 0 || current.fetchedAt) {
        if (provider.kind === "addresses") await deps.clearAddresses();
        else await deps.setRanges([]);
        await deps.setSource(provider.id, { count: 0, fetchedAt: null, attemptedAt: current.attemptedAt, error: null, fetchedWith: null });
        result[provider.id] = "cleared";
      }
      continue;
    }
    if (!isDue(provider, current, config.with, now)) {
      result[provider.id] = "skipped";
      continue;
    }

    const attemptedAt = new Date(now).toISOString();
    try {
      const apiKey = provider.needsKey ? await deps.apiKey() : null;
      const entries = await provider.fetch({ apiKey, minConfidence: config.minConfidence });
      let count: number;
      if (provider.kind === "addresses") {
        count = await deps.applyAddresses(entries.map((e) => ({ ip: e.value, score: e.score ?? 0 })));
      } else {
        const ranges = blockableRanges(entries.map((e) => e.value), await deps.neverBanContext());
        await deps.setRanges(ranges);
        count = ranges.length;
      }
      await deps.setSource(provider.id, { count, fetchedAt: attemptedAt, attemptedAt, error: null, fetchedWith: config.with });
      result[provider.id] = "fetched";
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 200) : "Fetch failed";
      await deps.setSource(provider.id, { ...current, attemptedAt, error });
      result[provider.id] = "failed";
    }
  }
  return result;
}
