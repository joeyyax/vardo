// Postgres deploy queue: enqueue, claim, lease, cancel and exclusive swaps. Times come from the database clock.

import { and, count, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { deployments, environments, type DeployCancelReason, type DeployRequest } from "@/lib/db/schema";
import { maxDeployConcurrency } from "@/lib/resources/host";
import { VARDO_SELF_APP_NAME } from "@/lib/self-app-name";
import type { DeployOpts, DeployStage } from "@/lib/docker/deploy";

/** Lease a claim holds without renewal. */
export const LEASE_TTL_MS = 45_000;

/** How often an executor renews its leases and reads cancel requests. */
export const LEASE_RENEW_MS = 3_000;

/** How long an exclusive swap waits for other deploys before going ahead. */
export const EXCLUSIVE_WAIT_MS = 15 * 60_000;

/** Age past which an exclusive flag no longer blocks claims. */
export const EXCLUSIVE_MAX_AGE_MS = 30 * 60_000;

const AUTOMATIC_TRIGGERS = ["webhook", "relay", "poll"] as const;
const SUPERSEDABLE_STAGES = ["queued", "clone", "compose", "build"] as const;
const TERMINAL_STATUSES = new Set(["success", "failed", "cancelled", "rolled_back", "superseded"]);

type Trigger = DeployOpts["trigger"];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type EnqueueOpts = Pick<
  DeployOpts,
  "appId" | "trigger" | "triggeredBy" | "environmentId" | "groupEnvironmentId" | "rollback" | "gitSha" | "pinIntent" | "rebuild"
>;

export type EnqueueResult = {
  id: string;
  scopeKey: string;
  /** Queued rows this deploy replaced. */
  superseded: string[];
  /** Running rows asked to stop for this deploy. */
  cancelRequested: string[];
};

export function isAutomaticTrigger(trigger: Trigger): boolean {
  return (AUTOMATIC_TRIGGERS as readonly string[]).includes(trigger);
}

/** `appId` for the default environment or none, `appId:environmentId` otherwise. */
export async function scopeKeyFor(appId: string, environmentId?: string | null, tx: Tx | typeof db = db): Promise<string> {
  if (!environmentId) return appId;
  const [env] = await tx
    .select({ isDefault: environments.isDefault })
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.appId, appId)));
  return env && !env.isDefault ? `${appId}:${environmentId}` : appId;
}

function requestOf(opts: EnqueueOpts): DeployRequest | null {
  const request: DeployRequest = {};
  if (opts.rebuild) request.rebuild = opts.rebuild;
  if (opts.rollback) request.rollback = opts.rollback;
  if (opts.gitSha) request.gitSha = opts.gitSha;
  if (opts.pinIntent) request.pinIntent = opts.pinIntent;
  return Object.keys(request).length > 0 ? request : null;
}

function logLine(tag: string, message: string): string {
  return `[${new Date().toISOString()}] [${tag}] ${message}`;
}

function appendLog(line: string) {
  return sql`coalesce(${deployments.log} || E'\n', '') || ${line}`;
}

/** Marks queued rows the new deploy replaces and asks running automatic ones to stop. */
async function applySupersede(tx: Tx, id: string, scopeKey: string, opts: Pick<EnqueueOpts, "trigger" | "gitSha" | "rollback">) {
  const automatic = isAutomaticTrigger(opts.trigger);
  // An explicit deploy replaces queued pushes only when it builds the branch head.
  const tracksHead = !opts.gitSha && !opts.rollback && opts.trigger !== "rollback";

  let superseded: string[] = [];
  if (automatic || tracksHead) {
    const rows = await tx
      .update(deployments)
      .set({
        status: "superseded",
        supersededBy: id,
        finishedAt: new Date(),
        log: appendLog(logLine("deploy", `Superseded by deployment ${id}`)),
      })
      .where(
        and(
          eq(deployments.scopeKey, scopeKey),
          eq(deployments.status, "queued"),
          inArray(deployments.trigger, [...AUTOMATIC_TRIGGERS]),
          ne(deployments.id, id),
        ),
      )
      .returning({ id: deployments.id });
    superseded = rows.map((r) => r.id);
  }

  let cancelRequested: string[] = [];
  if (automatic) {
    const rows = await tx
      .update(deployments)
      .set({ cancelRequestedAt: sql`now()`, cancelReason: "supersede" })
      .where(
        and(
          eq(deployments.scopeKey, scopeKey),
          eq(deployments.status, "running"),
          inArray(deployments.trigger, [...AUTOMATIC_TRIGGERS]),
          isNull(deployments.cancelRequestedAt),
          or(isNull(deployments.stage), inArray(deployments.stage, [...SUPERSEDABLE_STAGES])),
        ),
      )
      .returning({ id: deployments.id });
    cancelRequested = rows.map((r) => r.id);
  }
  return { superseded, cancelRequested };
}

async function lockClaims(tx: Tx) {
  // Claims and the exclusive hold run one at a time, so a claim never lands after the hold.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vardo:deploy-claim'))`);
}

async function lockScope(tx: Tx, scopeKey: string) {
  // Enqueues in one scope run one at a time, so each sees the rows before it.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('vardo:deploy-scope'), hashtext(${scopeKey}))`);
}

/** Inserts a queued deploy and applies the supersede rules for its scope, in one transaction. With `hold`, nothing claims it until `releaseHeldDeploy`. */
export async function enqueueDeploy(opts: EnqueueOpts, { hold = false }: { hold?: boolean } = {}): Promise<EnqueueResult> {
  const id = nanoid();
  const request = requestOf(opts);

  if (hold) {
    const scopeKey = await scopeKeyFor(opts.appId, opts.environmentId);
    await db.insert(deployments).values({
      id,
      appId: opts.appId,
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy,
      status: "queued",
      environmentId: opts.environmentId,
      groupEnvironmentId: opts.groupEnvironmentId,
      rollbackFromId: opts.rollback?.targetDeploymentId,
      scopeKey: null,
      request: { ...request, held: true },
    });
    return { id, scopeKey, superseded: [], cancelRequested: [] };
  }

  return db.transaction(async (tx) => {
    const scopeKey = await scopeKeyFor(opts.appId, opts.environmentId, tx);
    await lockScope(tx, scopeKey);

    await tx.insert(deployments).values({
      id,
      appId: opts.appId,
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy,
      status: "queued",
      environmentId: opts.environmentId,
      groupEnvironmentId: opts.groupEnvironmentId,
      rollbackFromId: opts.rollback?.targetDeploymentId,
      scopeKey,
      request,
    });

    return { id, scopeKey, ...(await applySupersede(tx, id, scopeKey, opts)) };
  });
}

/** Gives a held or pre-queue deploy its scope so executors can claim it. False when it's no longer queued or a newer push replaced it. */
export async function releaseHeldDeploy(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const unreleased = and(eq(deployments.id, id), eq(deployments.status, "queued"), isNull(deployments.scopeKey));
    const [row] = await tx
      .select({
        appId: deployments.appId,
        environmentId: deployments.environmentId,
        trigger: deployments.trigger,
        request: deployments.request,
        startedAt: deployments.startedAt,
      })
      .from(deployments)
      .where(unreleased);
    if (!row) return false;
    const scopeKey = await scopeKeyFor(row.appId, row.environmentId, tx);
    await lockScope(tx, scopeKey);

    // A pre-queue push gives way to a newer one in its scope, as its enqueue would have.
    if (!row.request?.held && isAutomaticTrigger(row.trigger)) {
      const [newer] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.scopeKey, scopeKey),
            inArray(deployments.status, ["queued", "running"]),
            inArray(deployments.trigger, [...AUTOMATIC_TRIGGERS]),
            gt(deployments.startedAt, row.startedAt),
          ),
        )
        .orderBy(desc(deployments.startedAt))
        .limit(1);
      if (newer) {
        await tx
          .update(deployments)
          .set({
            status: "superseded",
            supersededBy: newer.id,
            finishedAt: new Date(),
            log: appendLog(logLine("deploy", `Superseded by deployment ${newer.id}`)),
          })
          .where(unreleased);
        return false;
      }
    }

    const rest: DeployRequest = { ...row.request };
    delete rest.held;
    const released = await tx
      .update(deployments)
      .set({ scopeKey, request: Object.keys(rest).length > 0 ? rest : null })
      .where(unreleased)
      .returning({ id: deployments.id });
    if (released.length === 0) return false;
    await applySupersede(tx, id, scopeKey, { trigger: row.trigger, gitSha: rest.gitSha, rollback: rest.rollback });
    return true;
  });
}

export type ClaimOpts = {
  /** "only" claims the Vardo self app alone; "exclude" claims everything else. */
  self?: "only" | "exclude";
  /** Host-wide running limit. Defaults to the deploy concurrency setting. */
  capacity?: number;
  leaseMs?: number;
};

export type ClaimedDeploy = {
  id: string;
  appId: string;
  trigger: Trigger;
  triggeredBy: string | null;
  environmentId: string | null;
  groupEnvironmentId: string | null;
  scopeKey: string;
  request: DeployRequest | null;
  attempts: number;
  /** It had a queue wait open, which the claim ends. */
  waited?: boolean;
};

/** A write that hit the one-running-row-per-scope index. */
export function isScopeConflict(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { constraint_name?: string }).constraint_name === "deployment_scope_running_uniq") return true;
  }
  return false;
}

/** Claims queued deploys up to free capacity: one per idle scope, explicit triggers first, then oldest. */
export async function claimDeploys(executorId: string, opts: ClaimOpts = {}): Promise<ClaimedDeploy[]> {
  const capacity = opts.capacity ?? maxDeployConcurrency();
  const leaseMs = opts.leaseMs ?? LEASE_TTL_MS;
  const automatic = sql`d.trigger IN ('webhook', 'relay', 'poll')`;
  const selfFilter =
    opts.self === "only"
      ? sql`AND a.name = ${VARDO_SELF_APP_NAME}`
      : opts.self === "exclude"
        ? sql`AND a.name <> ${VARDO_SELF_APP_NAME}`
        : sql``;

  try {
    const claimed = await db.transaction(async (tx) => {
      await lockClaims(tx);

      const [state] = await tx.execute<{ running: number; exclusive: boolean }>(sql`
        SELECT
          (SELECT count(*)::int FROM deployment WHERE status = 'running') AS running,
          EXISTS (
            SELECT 1 FROM deployment
            WHERE exclusive_requested_at > now() - ${EXCLUSIVE_MAX_AGE_MS}::int * interval '1 millisecond'
          ) AS exclusive`);
      const free = capacity - state.running;
      if (state.exclusive || free <= 0) return [];

      return tx.execute<{
        id: string;
        app_id: string;
        trigger: Trigger;
        triggered_by: string | null;
        environment_id: string | null;
        group_environment_id: string | null;
        scope_key: string;
        request: DeployRequest | null;
        attempts: number;
        explicit: boolean;
        waited: boolean;
        started_at: Date;
      }>(sql`
        WITH heads AS (
          SELECT DISTINCT ON (d.scope_key) d.id, NOT ${automatic} AS explicit, d.started_at
          FROM deployment d JOIN app a ON a.id = d.app_id
          WHERE d.status = 'queued' AND d.scope_key IS NOT NULL ${selfFilter}
            AND NOT EXISTS (SELECT 1 FROM deployment r WHERE r.scope_key = d.scope_key AND r.status = 'running')
            -- Delete next release: a pre-queue running row has no scope, so it holds every scope of its app.
            AND NOT EXISTS (
              SELECT 1 FROM deployment l
              WHERE l.app_id = d.app_id AND l.status = 'running' AND l.scope_key IS NULL AND l.claimed_by IS NULL
            )
          ORDER BY d.scope_key, ${automatic}, d.started_at, d.id
        ), picked AS (
          SELECT d.id, h.explicit, d.wait_reason IS NOT NULL AS waited FROM deployment d JOIN heads h ON h.id = d.id
          WHERE d.status = 'queued'
          ORDER BY h.explicit DESC, h.started_at, h.id
          LIMIT ${free}
          FOR UPDATE OF d SKIP LOCKED
        )
        UPDATE deployment d SET
          status = 'running',
          claimed_by = ${executorId},
          lease_expires_at = now() + ${leaseMs}::int * interval '1 millisecond',
          stage = NULL,
          wait_reason = NULL,
          wait_ahead = NULL,
          wait_total = NULL,
          waiting_since = NULL
        FROM picked WHERE d.id = picked.id
        RETURNING d.id, d.app_id, d.trigger, d.triggered_by, d.environment_id, d.group_environment_id,
          d.scope_key, d.request, d.attempts, picked.explicit, picked.waited, d.started_at`);
    });

    return [...claimed]
      .sort((a, b) => Number(b.explicit) - Number(a.explicit) || +new Date(a.started_at) - +new Date(b.started_at))
      .map((r) => ({
        id: r.id,
        appId: r.app_id,
        trigger: r.trigger,
        triggeredBy: r.triggered_by,
        environmentId: r.environment_id,
        groupEnvironmentId: r.group_environment_id,
        scopeKey: r.scope_key,
        request: r.request,
        attempts: r.attempts,
        waited: r.waited,
      }));
  } catch (err) {
    // A row written as running outside the queue took a scope first; the next pass claims around it.
    if (isScopeConflict(err)) return [];
    throw err;
  }
}

export type LeaseRenewal = {
  /** Held rows with a cancel requested. */
  cancel: { id: string; reason: DeployCancelReason | null }[];
  /** Ids this executor no longer holds. */
  lost: string[];
};

/** Extends the executor's leases and reports cancel requests and lost rows. */
export async function renewLeases(executorId: string, ids: string[], leaseMs = LEASE_TTL_MS): Promise<LeaseRenewal> {
  if (ids.length === 0) return { cancel: [], lost: [] };
  const rows = await db
    .update(deployments)
    .set({ leaseExpiresAt: sql`now() + ${leaseMs}::int * interval '1 millisecond'` })
    .where(and(inArray(deployments.id, ids), eq(deployments.claimedBy, executorId), eq(deployments.status, "running")))
    .returning({ id: deployments.id, cancelRequestedAt: deployments.cancelRequestedAt, cancelReason: deployments.cancelReason });
  const held = new Set(rows.map((r) => r.id));
  return {
    cancel: rows.filter((r) => r.cancelRequestedAt).map((r) => ({ id: r.id, reason: r.cancelReason })),
    lost: ids.filter((id) => !held.has(id)),
  };
}

/** Cancels a queued row outright or flags a running one. A user or timeout reason replaces a supersede. */
export async function requestCancel(id: string, reason: DeployCancelReason): Promise<"cancelled" | "requested" | "inactive"> {
  const cancelled = await db
    .update(deployments)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      cancelRequestedAt: sql`now()`,
      cancelReason: reason,
      log: appendLog(logLine("CANCELLED", reason === "user" ? "Cancelled before it started" : `Cancelled before it started (${reason})`)),
    })
    .where(and(eq(deployments.id, id), eq(deployments.status, "queued")))
    .returning({ id: deployments.id });
  if (cancelled.length > 0) return "cancelled";

  const flagged = await db
    .update(deployments)
    .set({
      cancelRequestedAt: sql`coalesce(${deployments.cancelRequestedAt}, now())`,
      cancelReason: sql`CASE WHEN ${deployments.cancelReason} IS NULL OR ${deployments.cancelReason} = 'supersede' THEN ${reason} ELSE ${deployments.cancelReason} END`,
    })
    .where(and(eq(deployments.id, id), eq(deployments.status, "running")))
    .returning({ id: deployments.id });
  return flagged.length > 0 ? "requested" : "inactive";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type FinishedDeployment = Pick<
  typeof deployments.$inferSelect,
  "id" | "status" | "log" | "durationMs" | "postDeployError" | "supersededBy" | "finishedAt"
>;

/** Polls a deployment until it reaches a terminal status. */
export async function awaitDeployment(id: string, opts: { signal?: AbortSignal; pollMs?: number } = {}): Promise<FinishedDeployment> {
  for (;;) {
    const [row] = await db
      .select({
        id: deployments.id,
        status: deployments.status,
        log: deployments.log,
        durationMs: deployments.durationMs,
        postDeployError: deployments.postDeployError,
        supersededBy: deployments.supersededBy,
        finishedAt: deployments.finishedAt,
      })
      .from(deployments)
      .where(eq(deployments.id, id));
    if (!row) throw new Error(`Deployment ${id} not found`);
    if (TERMINAL_STATUSES.has(row.status)) return row;
    await sleep(opts.pollMs ?? 1_000, opts.signal);
  }
}

/** Waits for an executor to claim a queued deploy. Past the timeout it cancels the row and returns false. */
export async function awaitClaim(id: string, timeoutMs: number, opts: { pollMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db.select({ status: deployments.status }).from(deployments).where(eq(deployments.id, id));
    if (!row) throw new Error(`Deployment ${id} not found`);
    if (row.status !== "queued") return true;
    if (Date.now() >= deadline) {
      // Only a row still queued; one claimed just now runs on.
      const cancelled = await db
        .update(deployments)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          cancelRequestedAt: sql`now()`,
          cancelReason: "timeout",
          log: appendLog(logLine("CANCELLED", "No executor started it in time")),
        })
        .where(and(eq(deployments.id, id), eq(deployments.status, "queued")))
        .returning({ id: deployments.id });
      return cancelled.length === 0;
    }
    await sleep(Math.min(opts.pollMs ?? 1_000, Math.max(0, deadline - Date.now())));
  }
}

/** Running deploys other than this one. */
export async function runningExcept(id: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(deployments)
    .where(and(eq(deployments.status, "running"), ne(deployments.id, id)));
  return row.n;
}

export type ExclusiveOpts = {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  /** Called every `noticeMs` while other deploys run. */
  onWait?: (running: number) => void;
  noticeMs?: number;
};

/** Flags a running deploy's swap as exclusive and waits for every other deploy to finish, up to the timeout. Returns how many still run. */
export async function requestExclusive(id: string, opts: ExclusiveOpts = {}): Promise<{ running: number; waitedMs: number }> {
  const flagged = await db.transaction(async (tx) => {
    await lockClaims(tx);
    return tx
      .update(deployments)
      .set({ exclusiveRequestedAt: sql`coalesce(${deployments.exclusiveRequestedAt}, now())` })
      .where(and(eq(deployments.id, id), eq(deployments.status, "running")))
      .returning({ id: deployments.id });
  });
  if (flagged.length === 0) throw new Error(`Deployment ${id} isn't running`);

  const timeoutMs = opts.timeoutMs ?? EXCLUSIVE_WAIT_MS;
  const noticeMs = opts.noticeMs ?? 30_000;
  const start = Date.now();
  let lastNotice = start;
  try {
    for (;;) {
      const running = await runningExcept(id);
      const waitedMs = Date.now() - start;
      if (running === 0 || waitedMs >= timeoutMs) return { running, waitedMs };
      if (Date.now() - lastNotice >= noticeMs) {
        opts.onWait?.(running);
        lastNotice = Date.now();
      }
      await sleep(Math.min(opts.pollMs ?? 1_000, timeoutMs - waitedMs), opts.signal);
    }
  } catch (err) {
    await releaseExclusive(id);
    throw err;
  }
}

/** Clears the exclusive flag so claims resume. */
export async function releaseExclusive(id: string): Promise<void> {
  await db.update(deployments).set({ exclusiveRequestedAt: null }).where(eq(deployments.id, id));
}

/** Records the stage in flight. Returns the row's cancel request, or null once this executor no longer holds it. */
export async function markStage(
  executorId: string,
  id: string,
  stage: DeployStage,
): Promise<{ cancel: DeployCancelReason | null } | null> {
  const [row] = await db
    .update(deployments)
    .set({ stage })
    .where(and(eq(deployments.id, id), eq(deployments.claimedBy, executorId), eq(deployments.status, "running")))
    .returning({ cancelRequestedAt: deployments.cancelRequestedAt, cancelReason: deployments.cancelReason });
  if (!row) return null;
  return { cancel: row.cancelRequestedAt ? (row.cancelReason ?? "user") : null };
}

export type EnterSwapOpts = { leaseMs?: number; retryForMs?: number; retryEveryMs?: number };

/** Records the swap stage and renews the lease while this executor holds the row under a live one. False once it doesn't; throws when Postgres stays unreachable. */
export async function enterSwap(executorId: string, id: string, opts: EnterSwapOpts = {}): Promise<boolean> {
  const leaseMs = opts.leaseMs ?? LEASE_TTL_MS;
  const deadline = Date.now() + (opts.retryForMs ?? 30_000);
  for (;;) {
    try {
      const rows = await db
        .update(deployments)
        .set({ stage: "deploy", leaseExpiresAt: sql`now() + ${leaseMs}::int * interval '1 millisecond'` })
        .where(
          and(
            eq(deployments.id, id),
            eq(deployments.claimedBy, executorId),
            eq(deployments.status, "running"),
            sql`${deployments.leaseExpiresAt} > now()`,
          ),
        )
        .returning({ id: deployments.id });
      return rows.length > 0;
    } catch (err) {
      // A blip isn't a lost claim; past the window the swap doesn't go ahead unconfirmed.
      if (Date.now() >= deadline) throw new Error("Couldn't confirm the deploy's claim before the swap", { cause: err });
      await sleep(opts.retryEveryMs ?? 1_000);
    }
  }
}

/** The newest queued deploy in a scope: what a supersede hands over to. */
export async function newestQueuedIn(scopeKey: string): Promise<string | null> {
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.scopeKey, scopeKey), eq(deployments.status, "queued")))
    .orderBy(desc(deployments.startedAt))
    .limit(1);
  return row?.id ?? null;
}

/** Drops a supersede request that has nothing left to hand over to. */
export async function dropSupersede(id: string): Promise<void> {
  await db
    .update(deployments)
    .set({ cancelRequestedAt: null, cancelReason: null })
    .where(and(eq(deployments.id, id), eq(deployments.cancelReason, "supersede")));
}

/**
 * Clears exclusive flags left on finished rows. A self-deploy's success keeps its flag until a claimer
 * in the new slot clears it, so the old slot never claims in between. A claimer that can't read its slot leaves it.
 */
export async function clearFinishedExclusive(mySlot: string | null): Promise<number> {
  const rows = await db
    .update(deployments)
    .set({ exclusiveRequestedAt: null })
    .where(
      and(
        sql`${deployments.exclusiveRequestedAt} IS NOT NULL`,
        ne(deployments.status, "running"),
        ne(deployments.status, "queued"),
        or(
          ne(deployments.status, "success"),
          isNull(deployments.slot),
          mySlot === null ? sql`false` : eq(deployments.slot, mySlot),
        ),
      ),
    )
    .returning({ id: deployments.id });
  return rows.length;
}

/** No deploy queued or running, counted in Postgres. Fails closed. */
export async function isDeployQueueIdleInDb(): Promise<boolean> {
  try {
    const [row] = await db
      .select({ n: count() })
      .from(deployments)
      .where(inArray(deployments.status, ["queued", "running"]));
    return row.n === 0;
  } catch {
    return false;
  }
}

/** At most one deploy running and none queued, counted in Postgres. Fails closed. */
export async function isDeployQueueDrainedInDb(): Promise<boolean> {
  try {
    const [row] = await db
      .select({
        running: sql<number>`count(*) FILTER (WHERE ${deployments.status} = 'running')::int`,
        queued: sql<number>`count(*) FILTER (WHERE ${deployments.status} = 'queued')::int`,
      })
      .from(deployments)
      .where(inArray(deployments.status, ["queued", "running"]));
    return row.running <= 1 && row.queued === 0;
  } catch {
    return false;
  }
}
