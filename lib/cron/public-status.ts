// An org's cron health with nothing that names a job: counts, ages and intervals only.

import { randomBytes } from "crypto";
import { Cron } from "croner";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { cronJobs, cronStatusPages, jobHeartbeats } from "@/lib/db/schema";
import { staleWindowMs } from "@/lib/worker/jobs";

/** The loop whose heartbeat says the scheduler is alive. */
export const SCHEDULER_LOOP = "cron-tick";
const SCHEDULER_INTERVAL_MS = 60_000;
const CACHE_MS = 5_000;
const MAX_CACHED = 500;
const OVERDUE_FACTOR = 2;
// A tick lands up to a minute after the slot it runs.
const OVERDUE_SLACK_MS = 60_000;
const SAMPLE_RUNS = 8;

export const STATUS_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function newStatusToken(): string {
  return randomBytes(18).toString("base64url");
}

export type PublicJobState = "healthy" | "failing" | "overdue" | "never_run";

export type PublicJob = {
  state: PublicJobState;
  /** Seconds since the last run started; null when it never ran. */
  lastRunAgeS: number | null;
  /** Shortest gap between runs, in seconds; null for a schedule that never fires. */
  intervalS: number | null;
};

export type PublicCronStatus = {
  ok: boolean;
  jobs: number;
  healthy: number;
  failing: number;
  overdue: number;
  neverRun: number;
  /** Seconds since the scheduler last ticked; null when it never has. */
  schedulerAgeS: number | null;
  schedulerOk: boolean;
  checkedAt: string;
  list: PublicJob[];
};

/** The JSON a monitor polls. Aggregates only. */
export function toPublicJson(status: PublicCronStatus) {
  return {
    ok: status.ok,
    jobs: status.jobs,
    healthy: status.healthy,
    failing: status.failing,
    overdue: status.overdue,
    never_run: status.neverRun,
    scheduler_age_s: status.schedulerAgeS,
    checked_at: status.checkedAt,
  };
}

/** Shortest and longest gaps between the next few runs, in ms. Null when the schedule doesn't fire. */
export function scheduleGaps(schedule: string, timeZone: string | null, now: Date): { shortest: number; longest: number } | null {
  try {
    const runs = new Cron(schedule.trim(), timeZone ? { timezone: timeZone } : {}).nextRuns(SAMPLE_RUNS + 1, now);
    if (runs.length < 2) return null;
    let shortest = Infinity;
    let longest = 0;
    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i].getTime() - runs[i - 1].getTime();
      shortest = Math.min(shortest, gap);
      longest = Math.max(longest, gap);
    }
    return { shortest, longest };
  } catch {
    return null;
  }
}

export type StatusJobRow = {
  schedule: string;
  timeZone: string | null;
  lastRunAt: Date | null;
  lastStatus: string | null;
  createdAt: Date;
};

export function jobState(job: StatusJobRow, now: Date): PublicJob {
  const gaps = scheduleGaps(job.schedule, job.timeZone, now);
  const since = (job.lastRunAt ?? job.createdAt).getTime();
  const overdue = !!gaps && now.getTime() - since > OVERDUE_FACTOR * gaps.longest + OVERDUE_SLACK_MS;
  const state: PublicJobState =
    job.lastStatus === "failed" ? "failing" : overdue ? "overdue" : !job.lastRunAt ? "never_run" : "healthy";
  return {
    state,
    lastRunAgeS: job.lastRunAt ? Math.max(0, Math.round((now.getTime() - job.lastRunAt.getTime()) / 1000)) : null,
    intervalS: gaps ? Math.round(gaps.shortest / 1000) : null,
  };
}

const ORDER: Record<PublicJobState, number> = { failing: 0, overdue: 1, never_run: 2, healthy: 3 };

export function summarize(
  rows: StatusJobRow[],
  heartbeat: { lastTickAt: Date; intervalMs: number } | null,
  now: Date,
): PublicCronStatus {
  const list = rows
    .map((row) => jobState(row, now))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.intervalS ?? Infinity) - (b.intervalS ?? Infinity));
  const count = (state: PublicJobState) => list.filter((j) => j.state === state).length;
  const tickAge = heartbeat ? Math.max(0, now.getTime() - heartbeat.lastTickAt.getTime()) : null;
  const schedulerOk =
    tickAge !== null && tickAge <= staleWindowMs(heartbeat?.intervalMs ?? SCHEDULER_INTERVAL_MS);
  const failing = count("failing");
  const overdue = count("overdue");
  return {
    ok: schedulerOk && failing === 0 && overdue === 0,
    jobs: list.length,
    healthy: count("healthy"),
    failing,
    overdue,
    neverRun: count("never_run"),
    schedulerAgeS: tickAge === null ? null : Math.round(tickAge / 1000),
    schedulerOk,
    checkedAt: now.toISOString(),
    list,
  };
}

/** The enabled jobs the scheduler would run: no names, URLs, commands or headers are read. */
async function loadStatus(organizationId: string, now: Date): Promise<PublicCronStatus> {
  const [jobs, heartbeat] = await Promise.all([
    db.query.cronJobs.findMany({
      where: and(eq(cronJobs.organizationId, organizationId), eq(cronJobs.enabled, true)),
      columns: { type: true, schedule: true, timeZone: true, lastRunAt: true, lastStatus: true, createdAt: true },
      with: { app: { columns: { status: true } } },
    }),
    db.query.jobHeartbeats.findFirst({
      where: eq(jobHeartbeats.name, SCHEDULER_LOOP),
      columns: { lastTickAt: true, intervalMs: true },
    }),
  ]);
  const runnable = jobs.filter((j) => (j.app ? j.app.status === "active" : j.type === "url"));
  return summarize(runnable, heartbeat ?? null, now);
}

const cache = new Map<string, { at: number; value: Promise<PublicCronStatus | null> }>();

/** The status behind a token, or null when the page is off or unknown. Cached a few seconds per token. */
export function publicCronStatus(token: string): Promise<PublicCronStatus | null> {
  if (!STATUS_TOKEN_RE.test(token)) return Promise.resolve(null);
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  const value = (async () => {
    const page = await db.query.cronStatusPages.findFirst({
      where: eq(cronStatusPages.token, token),
      columns: { organizationId: true, enabled: true },
    });
    if (!page?.enabled) return null;
    return loadStatus(page.organizationId, new Date(now));
  })();
  // A failed read isn't cached.
  value.catch(() => {
    if (cache.get(token)?.value === value) cache.delete(token);
  });

  cache.delete(token);
  cache.set(token, { at: now, value });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return value;
}

export function clearPublicCronStatusCache(): void {
  cache.clear();
}

/** "45s", "12m", "3h", "2d". */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** "every minute", "every 5m", "every 1d". */
export function formatInterval(seconds: number): string {
  return seconds <= 60 ? "every minute" : `every ${formatAge(seconds)}`;
}
