// Worker rows: each worker's heartbeat, readiness and drain state. Every time comes from the database clock.

import { and, eq, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workers, type WorkerRow } from "@/lib/db/schema";
import { WORKER_FRESH_MS } from "./mode";

/** Rows that last beat longer ago than this are pruned. */
const PRUNE_AFTER_MS = 24 * 60 * 60_000;
/** A stopped worker stays listed this long after its last beat. */
const LISTED_AFTER_STOP_MS = 60 * 60_000;

export type WorkerIdentity = { id: string; role: string; slot: string | null; gitSha: string | null };

/** Deletes rows that stopped beating PRUNE_AFTER_MS ago. The newest stays, so an outage keeps its start. */
export async function pruneWorkers(): Promise<number> {
  const gone = await db
    .delete(workers)
    .where(
      and(
        lt(workers.heartbeatAt, sql`now() - ${PRUNE_AFTER_MS}::int * interval '1 millisecond'`),
        ne(workers.id, sql`(SELECT id FROM worker ORDER BY heartbeat_at DESC LIMIT 1)`),
      ),
    )
    .returning({ id: workers.id });
  return gone.length;
}

/** Records a starting worker and prunes long-gone ones. */
export async function registerWorker(w: WorkerIdentity): Promise<void> {
  await pruneWorkers();
  await db
    .insert(workers)
    .values({ id: w.id, role: w.role, slot: w.slot, gitSha: w.gitSha, startedAt: sql`now()`, heartbeatAt: sql`now()` })
    .onConflictDoUpdate({ target: workers.id, set: { heartbeatAt: sql`now()` } });
}

export type Beat = { inFlight: string[]; ready: boolean; draining: boolean };

/** Refreshes the heartbeat. Returns whether a drain was requested. */
export async function beatWorker(id: string, beat: Beat): Promise<{ drainRequested: boolean }> {
  const [row] = await db
    .update(workers)
    .set({
      heartbeatAt: sql`now()`,
      inFlight: beat.inFlight,
      readyAt: beat.ready ? sql`coalesce(${workers.readyAt}, now())` : null,
      drainingAt: beat.draining ? sql`coalesce(${workers.drainingAt}, now())` : null,
    })
    .where(eq(workers.id, id))
    .returning({ drainRequestedAt: workers.drainRequestedAt });
  return { drainRequested: !!row?.drainRequestedAt };
}

/** Every worker row, with the database's now. */
export async function readWorkers(): Promise<{ now: Date; rows: WorkerRow[] }> {
  const [rows, [clock]] = await Promise.all([
    db.select().from(workers),
    db.execute<{ now: string | Date }>(sql`SELECT now() AS now`),
  ]);
  return { now: new Date(clock.now), rows };
}

type Presence = Pick<WorkerRow, "heartbeatAt" | "readyAt" | "drainingAt">;

/** Beat within the window, booted and not draining: a worker web can hand its loops to. */
export function isPresent(row: Presence, now: Date, freshMs = WORKER_FRESH_MS): boolean {
  return now.getTime() - row.heartbeatAt.getTime() < freshMs && !!row.readyAt && !row.drainingAt;
}

/** Workers that beat within LISTED_AFTER_STOP_MS, newest beat first. */
export function recentWorkers<T extends Pick<WorkerRow, "heartbeatAt">>(rows: T[], now: Date): T[] {
  return rows
    .filter((row) => now.getTime() - row.heartbeatAt.getTime() < LISTED_AFTER_STOP_MS)
    .sort((a, b) => b.heartbeatAt.getTime() - a.heartbeatAt.getTime());
}

export type WorkerSummary = {
  /** Newest heartbeat from any worker. */
  workerAt: Date | null;
  /** Whether a present worker exists. */
  workerReady: boolean;
};

export function summarizeWorkers(rows: Presence[], now: Date): WorkerSummary {
  let workerAt: Date | null = null;
  for (const row of rows) if (!workerAt || row.heartbeatAt > workerAt) workerAt = row.heartbeatAt;
  return { workerAt, workerReady: rows.some((row) => isPresent(row, now)) };
}
