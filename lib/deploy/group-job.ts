// Project and group-environment deploys as `deploy-group` worker jobs. Each job enqueues its tiers' app deploys and waits on them.

import { and, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { workerJobs, type WorkerJobStatus } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { waitText } from "@/lib/docker/deploy-logger";
import { LEASE_RENEW_MS, LEASE_TTL_MS } from "./queue";
import { workerMissing } from "./waiting";

const log = logger.child("deploy-group-job");

export type GroupJobRequest = {
  projectId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api";
  triggeredBy?: string;
  groupEnvironmentId?: string;
};

export type ClaimedGroupJob = { id: string; request: GroupJobRequest };

/** Group jobs one executor runs at once. They wait on deploys, so they take no deploy capacity. */
export const GROUP_JOBS_PER_EXECUTOR = 4;

const TERMINAL: ReadonlySet<WorkerJobStatus> = new Set(["success", "failed", "cancelled"]);

/** A day, like a finished deploy's stream. */
const GROUP_STREAM_TTL_MS = 24 * 60 * 60 * 1000;

export const groupStream = (jobId: string) => `stream:deploy-group:${jobId}`;

/** Appends an event to the job's stream: `log`, `stage`, `tier` or `done`, with a JSON payload. */
export async function addGroupEvent(jobId: string, event: string, data: unknown): Promise<void> {
  const key = groupStream(jobId);
  await redis.xadd(key, "MAXLEN", "~", "5000", "*", "event", event, "data", JSON.stringify(data));
  if (event === "done") await redis.pexpire(key, GROUP_STREAM_TTL_MS);
}

/** Queues a group deploy. One runs at a time per project and group environment. */
export async function enqueueGroupDeploy(request: GroupJobRequest): Promise<string> {
  const id = nanoid();
  await db.insert(workerJobs).values({
    id,
    kind: "deploy-group",
    request,
    scopeKey: `group:${request.projectId}:${request.groupEnvironmentId ?? "production"}`,
  });
  return id;
}

/** How many apps a group deploy covers, read the way the job reads them when it runs. */
export async function groupDeployCount(request: GroupJobRequest): Promise<number> {
  const { groupApps } = await import("@/lib/docker/deploy-group");
  return (await groupApps(request)).members.length;
}

/** Claims queued group jobs whose scope is idle, oldest first. */
export async function claimGroupJobs(executorId: string, limit: number): Promise<ClaimedGroupJob[]> {
  if (limit <= 0) return [];
  const rows = await db.execute<{ id: string; request: GroupJobRequest }>(sql`
    WITH picked AS (
      SELECT j.id FROM worker_job j
      WHERE j.kind = 'deploy-group' AND j.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM worker_job r WHERE r.scope_key = j.scope_key AND r.status = 'running')
        AND j.id = (
          SELECT q.id FROM worker_job q
          WHERE q.scope_key = j.scope_key AND q.status = 'queued'
          ORDER BY q.created_at, q.id LIMIT 1
        )
      ORDER BY j.created_at, j.id
      LIMIT ${limit}
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE worker_job j SET
      status = 'running',
      claimed_by = ${executorId},
      lease_expires_at = now() + ${LEASE_TTL_MS}::int * interval '1 millisecond'
    FROM picked WHERE j.id = picked.id AND j.status = 'queued'
    RETURNING j.id, j.request`);
  return [...rows].map((r) => ({ id: r.id, request: r.request }));
}

/** Extends this executor's group-job leases. Returns the ids it no longer holds. */
export async function renewGroupLeases(executorId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(workerJobs)
    .set({ leaseExpiresAt: sql`now() + ${LEASE_TTL_MS}::int * interval '1 millisecond'` })
    .where(and(inArray(workerJobs.id, ids), eq(workerJobs.claimedBy, executorId), eq(workerJobs.status, "running")))
    .returning({ id: workerJobs.id });
  const held = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !held.has(id));
}

async function finishGroupJob(id: string, executorId: string, status: WorkerJobStatus): Promise<void> {
  await db
    .update(workerJobs)
    .set({ status, finishedAt: sql`now()` })
    .where(and(eq(workerJobs.id, id), eq(workerJobs.claimedBy, executorId), eq(workerJobs.status, "running")));
}

type RunningGroupJob = { done: Promise<void>; controller: AbortController };

const g = globalThis as unknown as {
  __vardo_group_jobs?: { jobs: Map<string, RunningGroupJob>; timer: NodeJS.Timeout | null; executorId: string | null };
};
const state = (g.__vardo_group_jobs ??= { jobs: new Map(), timer: null, executorId: null });

/** Group jobs this process runs. */
export function groupJobsHere(): string[] {
  return [...state.jobs.keys()];
}

/** Renews leases and stops jobs that lost theirs. Their app deploys carry on. */
async function renewGroupPass(): Promise<void> {
  if (!state.executorId) return;
  try {
    for (const id of await renewGroupLeases(state.executorId, groupJobsHere())) {
      const job = state.jobs.get(id);
      if (!job || job.controller.signal.aborted) continue;
      log.warn(`Stopping group deploy ${id}: its lease was lost`);
      job.controller.abort(new Error("The group deploy's lease was lost"));
    }
  } catch (err) {
    log.warn("Couldn't renew group-job leases:", err);
  }
}

/** Tests only: one renewal pass now. */
export function renewGroupNowForTests(): Promise<void> {
  return renewGroupPass();
}

/** Runs a claimed group job without waiting for it. */
export function startGroupJob(job: ClaimedGroupJob, executorId: string): Promise<void> {
  state.executorId = executorId;
  if (!state.timer) {
    state.timer = setInterval(() => void renewGroupPass(), LEASE_RENEW_MS);
    state.timer.unref?.();
  }
  const controller = new AbortController();
  const done = (async () => {
    let status: WorkerJobStatus = "failed";
    try {
      const { deployGroup } = await import("@/lib/docker/deploy-group");
      const result = await deployGroup({
        ...job.request,
        onLog: (app, line) => void addGroupEvent(job.id, "log", { app, line }).catch(() => {}),
        onStage: (app, stage, s) => void addGroupEvent(job.id, "stage", { app, stage, status: s }).catch(() => {}),
        onTier: (tier, apps) => void addGroupEvent(job.id, "tier", { tier, apps }).catch(() => {}),
        signal: controller.signal,
      });
      status = result.success ? "success" : "failed";
      // The sweeper closed the stream of a job that lost its lease.
      if (!controller.signal.aborted) {
        await addGroupEvent(job.id, "done", { success: result.success, results: result.results, totalDurationMs: result.totalDurationMs });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Group job ${job.id} failed:`, err);
      if (!controller.signal.aborted) await addGroupEvent(job.id, "done", { success: false, error: message, results: [] }).catch(() => {});
    } finally {
      await finishGroupJob(job.id, executorId, status).catch((err) => log.warn(`Couldn't close group job ${job.id}:`, err));
      state.jobs.delete(job.id);
      if (state.jobs.size === 0 && state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
    }
  })();
  state.jobs.set(job.id, { done, controller });
  return done;
}

/** Waits for the group jobs running here, up to the budget. */
export async function drainGroupJobs(budgetMs: number): Promise<void> {
  const pending = [...state.jobs.values()].map((j) => j.done);
  if (pending.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.allSettled(pending), new Promise((r) => (timer = setTimeout(r, budgetMs)))]);
  clearTimeout(timer);
}

/** Relays a group job's stream events until its `done` event, the job ends without one, or the signal aborts. */
export async function tailGroupJob(
  id: string,
  send: (event: string, data: unknown) => void,
  opts: { signal?: AbortSignal; pollMs?: number; workerMissing?: () => Promise<boolean> } = {},
): Promise<void> {
  const { readStream } = await import("@/lib/stream/consumer");
  const missing = opts.workerMissing ?? workerMissing;
  const reader = new AbortController();
  const stop = () => reader.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  let queuedSaid = false;
  let workerSaid = false;
  // A job that dies without a `done` event ends the tail once its row is terminal.
  const watch = (async () => {
    while (!reader.signal.aborted) {
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 2_000));
      const [row] = await db.select({ status: workerJobs.status }).from(workerJobs).where(eq(workerJobs.id, id)).catch(() => []);
      if (row?.status === "queued" && !queuedSaid) {
        queuedSaid = true;
        send("log", { app: "group", line: "[group] Queued" });
      }
      // Only the worker claims group jobs.
      if (row?.status === "queued" && !workerSaid && (await missing())) {
        workerSaid = true;
        send("log", { app: "group", line: `[group] ${waitText("worker")}` });
      }
      if (!row || TERMINAL.has(row.status)) {
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 2_000));
        if (!reader.signal.aborted) send("done", { success: row?.status === "success", results: [], status: row?.status ?? "missing" });
        stop();
        return;
      }
    }
  })();
  try {
    for await (const entry of readStream(groupStream(id), { fromId: "0-0", signal: reader.signal, blockMs: 1000 })) {
      const data = JSON.parse(entry.fields.data ?? "null");
      send(entry.fields.event, data);
      if (entry.fields.event === "done") break;
    }
  } finally {
    stop();
    opts.signal?.removeEventListener("abort", stop);
    await watch.catch(() => {});
  }
}

/** Polls a group job until it finishes. */
export async function awaitGroupJob(id: string, opts: { pollMs?: number; signal?: AbortSignal } = {}): Promise<WorkerJobStatus> {
  for (;;) {
    const [row] = await db.select({ status: workerJobs.status }).from(workerJobs).where(eq(workerJobs.id, id));
    if (!row) throw new Error(`Group job ${id} not found`);
    if (TERMINAL.has(row.status)) return row.status;
    if (opts.signal?.aborted) throw opts.signal.reason;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1_000));
  }
}
