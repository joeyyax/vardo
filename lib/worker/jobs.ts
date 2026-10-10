// Loop heartbeats in Postgres, so the system screen reads every process's loops and survives restarts.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobHeartbeats, type JobHeartbeatRow } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { redactSecrets } from "@/lib/redact";

const log = logger.child("worker:jobs");

/** Missed runs tolerated before a loop reads stale. */
const MISSED_RUNS_ALLOWED = 3;
/** Floor under a fast loop's window: a clean loop records at most every 15s. */
const MIN_STALE_WINDOW_MS = 60_000;
const MAX_ERROR_LENGTH = 500;

export type JobState = "ok" | "failing" | "stale" | "never";

/** How long a loop may go without a tick before it's stale rather than late. */
export function staleWindowMs(intervalMs: number): number {
  return Math.max(intervalMs * MISSED_RUNS_ALLOWED, MIN_STALE_WINDOW_MS);
}

export function jobState(
  row: Pick<JobHeartbeatRow, "intervalMs" | "lastTickAt" | "lastError"> | null,
  now: Date,
): JobState {
  if (!row) return "never";
  if (now.getTime() - row.lastTickAt.getTime() > staleWindowMs(row.intervalMs)) return "stale";
  return row.lastError ? "failing" : "ok";
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return redactSecrets(text).slice(0, MAX_ERROR_LENGTH);
}

/** A pass started, or a long one is still going. Never throws. */
export async function recordTick(name: string, role: string, holder: string, intervalMs: number): Promise<void> {
  try {
    await db
      .insert(jobHeartbeats)
      .values({ name, role, holder, intervalMs, lastTickAt: sql`now()` })
      .onConflictDoUpdate({
        target: jobHeartbeats.name,
        set: { role, holder, intervalMs, lastTickAt: sql`now()` },
      });
  } catch (err) {
    log.warn(`Recording a tick for ${name} failed: ${message(err)}`);
  }
}

/** A pass finished cleanly. Never throws. */
export async function recordOk(name: string): Promise<void> {
  try {
    await db
      .update(jobHeartbeats)
      .set({ lastTickAt: sql`now()`, lastOkAt: sql`now()`, lastError: null, consecutiveFailures: 0 })
      .where(eq(jobHeartbeats.name, name));
  } catch (err) {
    log.warn(`Recording a run of ${name} failed: ${message(err)}`);
  }
}

/** A pass threw. Returns the failure streak, or null when it couldn't be recorded. */
export async function recordFailure(name: string, err: unknown): Promise<number | null> {
  try {
    const [row] = await db
      .update(jobHeartbeats)
      .set({
        lastTickAt: sql`now()`,
        lastError: message(err),
        consecutiveFailures: sql`${jobHeartbeats.consecutiveFailures} + 1`,
      })
      .where(eq(jobHeartbeats.name, name))
      .returning({ consecutiveFailures: jobHeartbeats.consecutiveFailures });
    return row?.consecutiveFailures ?? null;
  } catch (recordErr) {
    log.warn(`Recording a failure of ${name} failed: ${message(recordErr)}`);
    return null;
  }
}

export type JobReading = { name: string; state: JobState; row: JobHeartbeatRow | null };

/** A reading per name, a never-run loop included, in the order given. */
export async function readJobs(names: string[]): Promise<{ now: Date; jobs: JobReading[] }> {
  const [rows, [clock]] = await Promise.all([
    db.select().from(jobHeartbeats),
    db.execute<{ now: string | Date }>(sql`SELECT now() AS now`),
  ]);
  const now = new Date(clock.now);
  const byName = new Map(rows.map((row) => [row.name, row]));
  return { now, jobs: names.map((name) => ({ name, state: jobState(byName.get(name) ?? null, now), row: byName.get(name) ?? null })) };
}
