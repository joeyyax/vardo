// Why a queued deploy hasn't started, for the deploy stream and the worker-offline banner.

import { and, count, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { maxDeployConcurrency } from "@/lib/resources/host";
import { VARDO_SELF_APP_NAME } from "@/lib/self-app-name";
import { WORKER_FRESH_MS } from "@/lib/worker/mode";
import { readWorkers } from "@/lib/worker/presence";
import { executorFor } from "./claim-scope";
import { EXCLUSIVE_MAX_AGE_MS } from "./queue";

export const WAITING_FOR_WORKER = "Waiting for the worker. Deploys start when it's back";

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

/** One line on what a queued deploy waits for. */
export async function queuedNotice(id: string): Promise<string> {
  const [row] = await db
    .select({ scopeKey: deployments.scopeKey, appName: apps.name, request: deployments.request })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(eq(deployments.id, id));
  if (!row) return "Queued";
  if (row.request?.held) return "Queued: getting ready to deploy";
  if (executorFor(row.appName === VARDO_SELF_APP_NAME) === "worker" && (await workerMissing())) return WAITING_FOR_WORKER;

  const [state] = await db.execute<{ running: number; scope_busy: boolean; exclusive: boolean }>(sql`
    SELECT
      (SELECT count(*)::int FROM deployment WHERE status = 'running') AS running,
      EXISTS (SELECT 1 FROM deployment WHERE status = 'running' AND scope_key = ${row.scopeKey}) AS scope_busy,
      EXISTS (
        SELECT 1 FROM deployment
        WHERE exclusive_requested_at > now() - ${EXCLUSIVE_MAX_AGE_MS}::int * interval '1 millisecond'
      ) AS exclusive`);
  if (state.exclusive) return "Waiting for Vardo's own update to finish its swap";
  if (state.scope_busy) return "Waiting for the deploy already running for this app";
  const capacity = maxDeployConcurrency();
  if (state.running >= capacity) return `Waiting for a free deploy slot (${capacity} at a time)`;
  return "Queued";
}
