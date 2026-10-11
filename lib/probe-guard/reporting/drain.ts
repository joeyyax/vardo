// One pass of the report queue: recheck, draft, send within the caps, and back off on 429.

import type { KeyedCooldown } from "@/lib/net/cooldown";
import { isRetryableError } from "@/lib/net/retry";
import { neverBanReason, type NeverBanContext } from "../ban-policy";
import type { AbuseSettings } from "../abuse-settings";
import { DEDUPE_MS, STALE_MS, reportDay, type ReportQueueStore } from "./queue";
import { ReportRateLimited, type AbuseReport, type AbuseReporter } from "./types";

export const DRAIN_BATCH = 20;
/** Wait before retrying an entry after a transient failure. */
const RETRY_LATER_MS = 5 * 60_000;

export type DrainDeps = {
  store: ReportQueueStore;
  cooldown: KeyedCooldown;
  reporter: AbuseReporter;
  settings: () => Promise<AbuseSettings>;
  apiKey: () => Promise<string | null>;
  neverBanContext: () => Promise<NeverBanContext>;
  draft: (ip: string, now: Date) => Promise<{ report: AbuseReport; appId: string | null } | null>;
  recordReported: (ip: string, appId: string | null, reporterId: string) => Promise<void>;
  /** Null clears the last error. */
  setStatus: (s: { error: string | null; reportedAt?: Date }) => Promise<void>;
  now?: () => number;
};

export type DrainResult = { sent: number; skipped: number; deferred: number; failed: number };

export async function drainReports(deps: DrainDeps, batch = DRAIN_BATCH): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
  const settings = await deps.settings();
  if (!settings.reporting.enabled) return result;
  const key = await deps.apiKey();
  if (!key) return result;

  const now = (deps.now ?? Date.now)();
  await deps.store.dropBefore(now - STALE_MS);
  if (await deps.cooldown.blocked(deps.reporter.id, now)) return result;

  const due = await deps.store.due(now, batch);
  if (due.length === 0) return result;
  const ctx = await deps.neverBanContext();
  const day = reportDay(now);
  let lastError: string | null = null;

  for (const ip of due) {
    if (!(await deps.store.remove(ip))) continue;
    // Rechecked at send time: the allowlist or linked instances may have changed since it was queued.
    if ((await deps.store.recentlyReported(ip)) || neverBanReason(ip, ctx)) {
      result.skipped++;
      continue;
    }
    const drafted = await deps.draft(ip, new Date(now));
    if (!drafted) {
      result.skipped++;
      continue;
    }
    if (!(await deps.store.reserveDaily(day, settings.reporting.dailyCap))) {
      await deps.store.requeue(ip, now);
      result.deferred++;
      break;
    }
    try {
      await deps.reporter.report(drafted.report, key);
      await deps.store.markReported(ip, DEDUPE_MS);
      await deps.cooldown.succeed(deps.reporter.id);
      await deps.recordReported(ip, drafted.appId, deps.reporter.id).catch(() => {});
      result.sent++;
    } catch (err) {
      await deps.store.releaseDaily(day);
      if (err instanceof ReportRateLimited && err.perAddress) {
        await deps.store.markReported(ip, DEDUPE_MS);
        result.skipped++;
        continue;
      }
      lastError = err instanceof Error ? err.message.slice(0, 200) : "Report failed";
      if (err instanceof ReportRateLimited) {
        await deps.cooldown.fail(deps.reporter.id, { retryAfterMs: err.retryAfterMs, now });
        await deps.store.requeue(ip, now);
        result.deferred++;
        break;
      }
      if (isRetryableError(err)) {
        await deps.cooldown.fail(deps.reporter.id, { now });
        await deps.store.requeue(ip, now + RETRY_LATER_MS);
        result.deferred++;
        break;
      }
      result.failed++;
    }
  }

  if (lastError) await deps.setStatus({ error: lastError });
  else if (result.sent > 0) await deps.setStatus({ error: null, reportedAt: new Date(now) });
  return result;
}
