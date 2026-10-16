// What a deploy waits on, kept on its row and its stream.

import { and, count, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { maxDeployConcurrency } from "@/lib/resources/host";
import { VARDO_SELF_APP_NAME } from "@/lib/self-app-name";
import { WORKER_FRESH_MS } from "@/lib/worker/mode";
import { readWorkers } from "@/lib/worker/presence";
import { addDeployLog } from "@/lib/stream/producer";
import { waitEntry, type WaitPlace, type WaitReason } from "@/lib/docker/deploy-logger";
import { etaMoved, lineEtas, slotFreeAt } from "./eta";
import { typicalDeploySql } from "./eta-history";
import { executorFor } from "./claim-scope";
import { EXCLUSIVE_MAX_AGE_MS, lockClaims } from "./queue";

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

/** Queued deploys waiting on a missing worker, in one org when given. Zero when a worker is present or none is expected. */
export async function deploysWaitingForWorker(organizationId?: string): Promise<number> {
  if (!(await workerMissing())) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(
      and(
        eq(deployments.status, "queued"),
        ne(apps.name, VARDO_SELF_APP_NAME),
        organizationId ? eq(apps.organizationId, organizationId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

/** No deploy runs and none can start: the worker is missing and every queued deploy needs it. Fails closed. */
export async function noDeployCanRun(): Promise<boolean> {
  if (!(await workerMissing())) return false;
  try {
    const [row] = await db
      .select({ n: count() })
      .from(deployments)
      .leftJoin(apps, eq(apps.id, deployments.appId))
      .where(
        or(
          eq(deployments.status, "running"),
          and(eq(deployments.status, "queued"), or(isNull(apps.name), eq(apps.name, VARDO_SELF_APP_NAME))),
        ),
      );
    return row?.n === 0;
  } catch {
    return false;
  }
}

/** Records a running deploy's own wait on its row. `restart` stamps a new start time. */
export async function recordWait(id: string, reason: WaitReason | null, place: WaitPlace, opts: { restart: boolean }): Promise<void> {
  const eta = reason === null || place.eta == null ? null : new Date(place.eta);
  await db
    .update(deployments)
    .set({
      waitReason: reason,
      waitAhead: reason === null ? null : (place.ahead ?? null),
      waitTotal: reason === null ? null : (place.total ?? null),
      waitEta: eta,
      ...(opts.restart || reason === null ? { waitingSince: reason === null ? null : sql`now()` } : {}),
    })
    .where(eq(deployments.id, id));
}

/** Sets the length of a line on every deploy waiting in it, in one statement. */
export async function recordQueueTotal(reason: WaitReason, total: number): Promise<void> {
  await db
    .update(deployments)
    .set({ waitTotal: total })
    .where(
      and(
        eq(deployments.waitReason, reason),
        inArray(deployments.status, ["queued", "running"]),
        sql`${deployments.waitTotal} IS DISTINCT FROM ${total}`,
      ),
    );
}

export type QueueWait = {
  id: string;
  wait_reason: WaitReason | null;
  wait_ahead: number | null;
  wait_total: number | null;
  wait_eta: string | null;
};

type QueuedRow = {
  id: string;
  reason: WaitReason | null;
  typical_ms: number | null;
  wait_reason: WaitReason | null;
  wait_ahead: number | null;
  wait_total: number | null;
  wait_eta: Date | string | null;
};

/** Records why each queued deploy waits and, in the deploy-slot line, its place, the line's length and start. Writes only rows that changed. */
export async function markQueueWaits(opts: { capacity?: number; workerMissing?: boolean; now?: number } = {}): Promise<QueueWait[]> {
  const capacity = opts.capacity ?? maxDeployConcurrency();
  const noWorker = opts.workerMissing ?? (await workerMissing());
  const automatic = sql`d.trigger IN ('webhook', 'relay', 'poll')`;

  // Same order as claimDeploys.
  const queued = await db.execute<QueuedRow>(sql`
    WITH state AS (
      SELECT
        (SELECT count(*)::int FROM deployment WHERE status = 'running') AS running,
        EXISTS (
          SELECT 1 FROM deployment
          WHERE exclusive_requested_at > now() - ${EXCLUSIVE_MAX_AGE_MS}::int * interval '1 millisecond'
        ) AS exclusive
    ), queued AS (
      SELECT d.id, d.app_id, d.started_at, d.bumped_at, NOT ${automatic} AS explicit, a.name AS app_name,
        d.wait_reason, d.wait_ahead, d.wait_total, d.wait_eta,
        row_number() OVER (PARTITION BY d.scope_key ORDER BY d.bumped_at DESC NULLS LAST, ${automatic}, d.started_at, d.id) AS in_scope,
        EXISTS (SELECT 1 FROM deployment r WHERE r.scope_key = d.scope_key AND r.status = 'running') AS scope_busy
      FROM deployment d JOIN app a ON a.id = d.app_id
      WHERE d.status = 'queued' AND d.scope_key IS NOT NULL
    ), reasons AS (
      SELECT q.*,
        CASE
          WHEN ${noWorker} AND q.app_name <> ${VARDO_SELF_APP_NAME} THEN 'worker'
          WHEN s.exclusive THEN 'exclusive'
          WHEN q.scope_busy OR q.in_scope > 1 THEN 'app'
          WHEN s.running >= ${capacity} THEN 'deploy-slot'
        END AS reason
      FROM queued q CROSS JOIN state s
    )
    SELECT r.id, r.reason, r.wait_reason, r.wait_ahead, r.wait_total, r.wait_eta,
      CASE WHEN r.reason = 'deploy-slot' THEN ${typicalDeploySql(sql`r.app_id`)} END AS typical_ms
    FROM reasons r
    ORDER BY r.bumped_at DESC NULLS LAST, r.explicit DESC, r.started_at, r.id`);

  const line = [...queued].filter((r) => r.reason === "deploy-slot");
  const now = opts.now ?? Date.now();
  let etas: (number | null)[] = [];
  if (line.length > 0) {
    const running = await db.execute<{ since: Date | string; typical_ms: number | null }>(sql`
      SELECT coalesce(d.claimed_at, d.started_at) AS since, ${typicalDeploySql(sql`d.app_id`)} AS typical_ms
      FROM deployment d WHERE d.status = 'running'`);
    const busy = [...running].map((r) => slotFreeAt(now, new Date(r.since).getTime(), r.typical_ms === null ? null : Number(r.typical_ms)));
    const idle = Array.from({ length: Math.max(0, capacity - busy.length) }, () => now);
    etas = lineEtas(now, [...busy, ...idle], line.map((r) => (r.typical_ms === null ? null : Number(r.typical_ms))));
  }

  const place = new Map(line.map((r, i) => [r.id, { ahead: i, total: line.length, eta: etas[i] ?? null }]));
  const changed = [...queued].flatMap((r) => {
    const p = place.get(r.id);
    const ahead = p?.ahead ?? null;
    const total = p?.total ?? null;
    const moved = etaMoved(r.wait_eta, p?.eta ?? null);
    if (r.wait_reason === r.reason && r.wait_ahead === ahead && r.wait_total === total && !moved) return [];
    const eta = moved ? (p?.eta ?? null) : r.wait_eta === null ? null : new Date(r.wait_eta).getTime();
    return [{ id: r.id, reason: r.reason, ahead, total, eta }];
  });
  if (changed.length === 0) return [];

  const values = sql.join(
    changed.map(
      (c) => sql`(${c.id}, ${c.reason}::text, ${c.ahead}::smallint, ${c.total}::smallint, ${c.eta === null ? null : new Date(c.eta).toISOString()}::timestamptz)`,
    ),
    sql`, `,
  );
  const written = await db.transaction(async (tx) => {
    await lockClaims(tx);
    return tx.execute<QueueWait>(sql`
      UPDATE deployment d SET
        wait_reason = v.reason,
        wait_ahead = v.ahead,
        wait_total = v.total,
        wait_eta = v.eta,
        waiting_since = CASE
          WHEN v.reason IS NULL THEN NULL
          WHEN d.wait_reason IS NOT DISTINCT FROM v.reason THEN d.waiting_since
          ELSE now()
        END
      FROM (VALUES ${values}) AS v(id, reason, ahead, total, eta)
      WHERE d.id = v.id AND d.status = 'queued'
      RETURNING d.id, d.wait_reason, d.wait_ahead, d.wait_total, d.wait_eta`);
  });

  for (const row of written) {
    const entry = waitEntry(
      row.wait_reason,
      { ahead: row.wait_ahead ?? undefined, total: row.wait_total ?? undefined, eta: row.wait_eta === null ? null : new Date(row.wait_eta).getTime() },
      "queued",
    );
    addDeployLog(row.id, entry).catch((err) => log.warn(`Couldn't write the wait for ${row.id}:`, err));
  }
  return [...written];
}

/** Ends the queue wait of deploys an executor just claimed. */
export async function endQueueWaits(ids: string[]): Promise<void> {
  for (const id of ids) {
    addDeployLog(id, waitEntry(null, {}, "queued")).catch((err) => log.warn(`Couldn't end the wait for ${id}:`, err));
  }
}

/** Clears wait state left on finished rows, such as a deploy cancelled while it waited. */
export async function clearFinishedWaits(): Promise<number> {
  const rows = await db
    .update(deployments)
    .set({ waitReason: null, waitAhead: null, waitTotal: null, waitEta: null, waitingSince: null })
    .where(and(isNotNull(deployments.waitReason), notInArray(deployments.status, ["queued", "running"])))
    .returning({ id: deployments.id });
  return rows.length;
}
