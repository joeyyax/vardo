// What a deploy waits on, kept on its row and its stream: the queue's reasons from the claim loop, the build gate's and the checkout lock's from the deploy.

import { and, count, eq, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { maxDeployConcurrency } from "@/lib/resources/host";
import { VARDO_SELF_APP_NAME } from "@/lib/self-app-name";
import { WORKER_FRESH_MS } from "@/lib/worker/mode";
import { readWorkers } from "@/lib/worker/presence";
import { addDeployLog } from "@/lib/stream/producer";
import { waitEntry, type WaitReason } from "@/lib/docker/deploy-logger";
import { executorFor } from "./claim-scope";
import { EXCLUSIVE_MAX_AGE_MS } from "./queue";

const log = logger.child("deploy-waiting");

/** Whether deploys need the worker and none beats, whatever runs the loops. A booting worker already claims, so readiness doesn't count. */
export async function workerMissing(): Promise<boolean> {
  if (executorFor(false) === "web") return false;
  try {
    const { now, rows } = await readWorkers();
    return !rows.some((row) => now.getTime() - row.heartbeatAt.getTime() < WORKER_FRESH_MS && !row.drainingAt);
  } catch {
    return false;
  }
}

/** Queued deploys waiting on a missing worker. Zero when a worker is present or none is expected. */
export async function deploysWaitingForWorker(): Promise<number> {
  if (!(await workerMissing())) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(and(eq(deployments.status, "queued"), ne(apps.name, VARDO_SELF_APP_NAME)));
  return row?.n ?? 0;
}

/** Records a running deploy's own wait on its row. `restart` stamps a new start time. */
export async function recordWait(id: string, reason: WaitReason | null, ahead: number | undefined, opts: { restart: boolean }): Promise<void> {
  await db
    .update(deployments)
    .set({
      waitReason: reason,
      waitAhead: reason === null ? null : (ahead ?? null),
      ...(opts.restart || reason === null ? { waitingSince: reason === null ? null : sql`now()` } : {}),
    })
    .where(eq(deployments.id, id));
}

type Changed = { id: string; wait_reason: WaitReason | null; wait_ahead: number | null };

/**
 * One statement for every queued deploy: why it hasn't started (the worker, Vardo's own swap, the app's running deploy, a deploy slot) and its place for a slot.
 * Writes only rows whose reason or place changed, and a stream entry for each, so two claimers running it don't both write.
 */
export async function markQueueWaits(opts: { capacity?: number; workerMissing?: boolean } = {}): Promise<Changed[]> {
  const capacity = opts.capacity ?? maxDeployConcurrency();
  const noWorker = opts.workerMissing ?? (await workerMissing());
  const automatic = sql`d.trigger IN ('webhook', 'relay', 'poll')`;

  const changed = await db.execute<Changed>(sql`
    WITH state AS (
      SELECT
        (SELECT count(*)::int FROM deployment WHERE status = 'running') AS running,
        EXISTS (
          SELECT 1 FROM deployment
          WHERE exclusive_requested_at > now() - ${EXCLUSIVE_MAX_AGE_MS}::int * interval '1 millisecond'
        ) AS exclusive
    ), queued AS (
      SELECT d.id, d.started_at, NOT ${automatic} AS explicit, a.name AS app_name,
        row_number() OVER (PARTITION BY d.scope_key ORDER BY ${automatic}, d.started_at, d.id) AS in_scope,
        EXISTS (SELECT 1 FROM deployment r WHERE r.scope_key = d.scope_key AND r.status = 'running') AS scope_busy
      FROM deployment d JOIN app a ON a.id = d.app_id
      WHERE d.status = 'queued' AND d.scope_key IS NOT NULL
    ), reasons AS (
      SELECT q.id, q.explicit, q.started_at,
        CASE
          WHEN ${noWorker} AND q.app_name <> ${VARDO_SELF_APP_NAME} THEN 'worker'
          WHEN s.exclusive THEN 'exclusive'
          WHEN q.scope_busy OR q.in_scope > 1 THEN 'app'
          WHEN s.running >= ${capacity} THEN 'deploy-slot'
        END AS reason
      FROM queued q CROSS JOIN state s
    ), placed AS (
      SELECT id, reason,
        CASE WHEN reason = 'deploy-slot'
          THEN (row_number() OVER (PARTITION BY reason ORDER BY explicit DESC, started_at, id) - 1)::smallint
        END AS ahead
      FROM reasons
    )
    UPDATE deployment d SET
      wait_reason = p.reason,
      wait_ahead = p.ahead,
      waiting_since = CASE
        WHEN p.reason IS NULL THEN NULL
        WHEN d.wait_reason IS NOT DISTINCT FROM p.reason THEN d.waiting_since
        ELSE now()
      END
    FROM placed p
    WHERE d.id = p.id AND d.status = 'queued'
      AND (d.wait_reason IS DISTINCT FROM p.reason OR d.wait_ahead IS DISTINCT FROM p.ahead)
    RETURNING d.id, d.wait_reason, d.wait_ahead`);

  for (const row of changed) {
    addDeployLog(row.id, waitEntry(row.wait_reason, row.wait_ahead ?? undefined, "queued")).catch((err) =>
      log.warn(`Couldn't write the wait for ${row.id}:`, err),
    );
  }
  return [...changed];
}

/** Ends the queue wait of deploys an executor just claimed. */
export async function endQueueWaits(ids: string[]): Promise<void> {
  for (const id of ids) {
    addDeployLog(id, waitEntry(null, undefined, "queued")).catch((err) => log.warn(`Couldn't end the wait for ${id}:`, err));
  }
}

/** Clears wait state left on finished rows, such as a deploy cancelled while it waited. */
export async function clearFinishedWaits(): Promise<number> {
  const rows = await db
    .update(deployments)
    .set({ waitReason: null, waitAhead: null, waitingSince: null })
    .where(and(isNotNull(deployments.waitReason), notInArray(deployments.status, ["queued", "running"])))
    .returning({ id: deployments.id });
  return rows.length;
}
