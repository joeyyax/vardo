// Worker rows: each worker's heartbeat, readiness and drain state. Every time comes from the database clock.

import { eq, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workers, type WorkerRow } from "@/lib/db/schema";
import { WORKER_FRESH_MS } from "./mode";

/** Rows older than this are pruned when a worker registers. */
const PRUNE_AFTER_MS = 24 * 60 * 60_000;

export type WorkerIdentity = { id: string; role: string; slot: string | null; gitSha: string | null };

/** Records a starting worker and prunes long-gone ones. */
export async function registerWorker(w: WorkerIdentity): Promise<void> {
  await db.delete(workers).where(lt(workers.heartbeatAt, sql`now() - ${PRUNE_AFTER_MS}::int * interval '1 millisecond'`));
  await db
    .insert(workers)
    .values({ id: w.id, role: w.role, slot: w.slot, gitSha: w.gitSha, startedAt: sql`now()`, heartbeatAt: sql`now()` })
    .onConflictDoUpdate({ target: workers.id, set: { heartbeatAt: sql`now()` } });
}

export type Beat = { inFlight: string[]; ready: boolean; draining: boolean };

/** Refreshes the heartbeat. */
export async function beatWorker(id: string, beat: Beat): Promise<void> {
  await db
    .update(workers)
    .set({
      heartbeatAt: sql`now()`,
      inFlight: beat.inFlight,
      readyAt: beat.ready ? sql`coalesce(${workers.readyAt}, now())` : null,
      drainingAt: beat.draining ? sql`coalesce(${workers.drainingAt}, now())` : null,
    })
    .where(eq(workers.id, id));
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
