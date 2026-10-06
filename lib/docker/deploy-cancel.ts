// ---------------------------------------------------------------------------
// Per-app deploy cancel-and-replace
//
// Ensures only one deploy runs per app environment at a time. The default
// environment is keyed by appId alone; any other is keyed `${appId}:${envId}`,
// so a preview never supersedes, cancels or waits on production. When a new
// deploy arrives for an environment that is already deploying:
//
//   - Safe stages (clone, compose, build): cancel the in-progress deploy
//     immediately by aborting the child process group. Mark the old deploy
//     as "superseded". Start the new deploy right away.
//
//   - Swap stages (deploy, healthcheck, routing, cleanup): let the current
//     deploy finish — it is already serving traffic or about to. The new
//     deploy starts as soon as the current one completes.
//
// Cross-process registry
// ----------------------
// The active-deploy state is kept in both an in-process Map (for AbortController
// and the "done" promise) AND in Redis (for cross-process visibility).
//
//   deploy:active:{appId}   — JSON: { deploymentId, stage }  lease: 30 s
//   deploy:cancel:{appId}   — JSON: { supersededBy }         TTL: 60 s
//
// The active entry is a lease the owning process renews while it runs, not a
// fixed TTL — it must not outlive the process holding it.
//
// When a new deploy arrives and finds a Redis entry owned by another process it
// writes deploy:cancel:{appId} and polls until the entry clears (up to 2 min).
// Each process checks deploy:cancel:{appId} at every stage transition and aborts
// its local controller when it finds a cancellation request for its deployment.
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema/apps";
import { environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { createDeployment, runDeployment } from "./deploy";
import { DeployBlockedError } from "./errors";
import type { DeployOpts, DeployResult, DeployStage } from "./deploy";
import {
  enqueueAndTryAcquire,
  waitForConcurrencySlot,
  releaseConcurrencySlot,
  removeFromQueue,
  getConcurrencyLimit,
} from "./deploy-concurrency";

const log = logger.child("deploy-cancel");

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

/**
 * Registry key for a deploy: the appId for the app's default environment (and
 * for anything that cannot be resolved), `${appId}:${environmentId}` otherwise.
 */
export async function deployScope(appId: string, environmentId?: string | null): Promise<string> {
  if (!environmentId) return appId;
  try {
    const env = await db.query.environments.findFirst({
      where: and(eq(environments.id, environmentId), eq(environments.appId, appId)),
      columns: { isDefault: true },
    });
    return env && !env.isDefault ? `${appId}:${environmentId}` : appId;
  } catch {
    return appId;
  }
}

const ACTIVE_KEY = (appId: string) => `deploy:active:${appId}`;
const CANCEL_KEY = (appId: string) => `deploy:cancel:${appId}`;
const KILL_KEY = (deploymentId: string) => `deploy:kill:${deploymentId}`;

/**
 * Lease on the active-deploy entry, renewed by the owning process while it
 * runs. A process that dies mid-deploy — a self-deploy stops its own container
 * before the release below can run — drops the entry within the lease instead
 * of holding the app for the length of a fixed TTL.
 */
export const ACTIVE_TTL_MS = 30 * 1000;

/** Renewal interval. Three beats fit inside the lease, so two may be missed. */
export const ACTIVE_HEARTBEAT_MS = 10 * 1000;

/** TTL for the cancel signal — consumed quickly by the target process. */
const CANCEL_TTL_MS = 60 * 1000; // 60 seconds

/** How long to wait for a foreign process to finish before giving up. */
const WAIT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Poll interval while waiting for a foreign deploy to clear. */
const WAIT_POLL_MS = 250;

// ---------------------------------------------------------------------------
// In-process registry (AbortController + done promise — cannot cross processes)
// ---------------------------------------------------------------------------

type ActiveDeploy = {
  deploymentId: string;
  controller: AbortController;
  // Stage is updated in real time as the deploy progresses
  stage: DeployStage;
  // Resolves when the deploy finishes (success, failure, or cancellation)
  done: Promise<void>;
};

// Keyed by appId — tracks deploys owned by THIS process
const localRegistry = new Map<string, ActiveDeploy>();

/** Set once a self-deploy starts draining this process before stopping it. */
let draining = false;

/** Upper bound on how long a self-deploy waits for this process's other deploys. */
export const SELF_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

const SELF_DRAIN_POLL_MS = 1000;

/**
 * Hold a self-deploy's final stop until every other deploy in this process has
 * finished, because that stop ends the process and every deploy running in it.
 * New deploys are refused from here on. Bounded: returns the deploys still
 * running at the deadline, which the stop will cut off.
 */
export async function drainForSelfStop(
  selfAppId: string,
  onLog: (line: string) => void,
  timeoutMs: number = SELF_DRAIN_TIMEOUT_MS,
): Promise<string[]> {
  draining = true;
  const others = () =>
    [...localRegistry.entries()]
      .filter(([scope]) => scope !== selfAppId)
      .map(([, entry]) => entry);

  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (others().length > 0 && Date.now() < deadline) {
    if (!announced) {
      onLog(
        `[deploy] Waiting for ${others().length} other deploy(s) in this process to finish before stopping it`,
      );
      announced = true;
    }
    const remaining = deadline - Date.now();
    await Promise.race([
      Promise.all(others().map((entry) => entry.done.catch(() => {}))),
      new Promise((r) => setTimeout(r, Math.min(SELF_DRAIN_POLL_MS, remaining))),
    ]);
  }
  return others().map((entry) => entry.deploymentId);
}

/** Take deploys again. For a self-deploy whose stop failed, leaving this process serving. */
export function endSelfDrain(): void {
  draining = false;
}

/** Test hook. */
export function resetDrainForTests(): void {
  draining = false;
  localRegistry.clear();
}

/**
 * Whether a deploy of this app is running or queued, here or in another
 * process. "unknown" when Redis cannot answer and nothing local is running.
 */
export async function deployInFlight(appId: string): Promise<boolean | "unknown"> {
  if (localRegistry.has(appId)) return true;
  try {
    return (await redis.get(ACTIVE_KEY(appId))) !== null;
  } catch {
    return "unknown";
  }
}

/**
 * Claim the app's active-deploy key for an operation that is not a deploy, such
 * as an instant rollback, so no deploy starts under it. A deploy arriving
 * meanwhile sees a swap-stage owner and waits. Null when the app is busy.
 */
export async function claimAppForOperation(
  appId: string,
  operation: string,
  ttlMs: number,
): Promise<{ release: () => Promise<void> } | null> {
  if (localRegistry.has(appId)) return null;
  const owner = `${operation}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await redis.set(
      ACTIVE_KEY(appId),
      JSON.stringify({ deploymentId: owner, stage: "routing" }),
      "PX",
      ttlMs,
      "NX",
    );
    if (ok !== "OK") return null;
  } catch {
    // Redis down: the local check above is all there is.
  }
  return { release: () => clearActiveInRedis(appId, owner) };
}

// ---------------------------------------------------------------------------
// Stages where a cancel costs nothing — no container has been stopped or
// started, so the previous slot is still serving.
// ---------------------------------------------------------------------------

export const SAFE_CANCEL_STAGES = new Set<DeployStage>(["clone", "compose", "build"]);

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

async function setActiveInRedis(
  appId: string,
  deploymentId: string,
  stage: DeployStage
): Promise<void> {
  try {
    await redis.set(
      ACTIVE_KEY(appId),
      JSON.stringify({ deploymentId, stage }),
      "PX",
      ACTIVE_TTL_MS
    );
  } catch {
    // Non-fatal — in-process registry still works for single-process setups
  }
}

export async function renewActiveLease(
  appId: string,
  deploymentId: string,
  stage: DeployStage
): Promise<void> {
  try {
    // Only update if we still own the key — avoid overwriting a newer deploy's entry
    const raw = await redis.get(ACTIVE_KEY(appId));
    if (!raw) return;
    const entry = JSON.parse(raw) as { deploymentId: string; stage: DeployStage };
    if (entry.deploymentId !== deploymentId) return;
    await redis.set(
      ACTIVE_KEY(appId),
      JSON.stringify({ deploymentId, stage }),
      "PX",
      ACTIVE_TTL_MS
    );
  } catch {
    // Non-fatal
  }
}

export async function clearActiveInRedis(appId: string, deploymentId: string): Promise<void> {
  try {
    const raw = await redis.get(ACTIVE_KEY(appId));
    if (!raw) return;
    const entry = JSON.parse(raw) as { deploymentId: string };
    // Only delete if we still own it
    if (entry.deploymentId === deploymentId) {
      await redis.del(ACTIVE_KEY(appId));
    }
  } catch {
    // Non-fatal
  }
}

async function getActiveFromRedis(
  appId: string
): Promise<{ deploymentId: string; stage: DeployStage } | null> {
  try {
    const raw = await redis.get(ACTIVE_KEY(appId));
    if (!raw) return null;
    return JSON.parse(raw) as { deploymentId: string; stage: DeployStage };
  } catch {
    return null;
  }
}

async function writeCancelSignal(appId: string, supersededBy: string): Promise<void> {
  try {
    await redis.set(
      CANCEL_KEY(appId),
      JSON.stringify({ supersededBy }),
      "PX",
      CANCEL_TTL_MS
    );
  } catch {
    // Non-fatal
  }
}

async function checkCancelSignal(
  appId: string
): Promise<{ supersededBy: string } | null> {
  try {
    const raw = await redis.get(CANCEL_KEY(appId));
    if (!raw) return null;
    return JSON.parse(raw) as { supersededBy: string };
  } catch {
    return null;
  }
}

async function clearCancelSignal(appId: string): Promise<void> {
  try {
    await redis.del(CANCEL_KEY(appId));
  } catch {
    // Non-fatal
  }
}

async function checkKillSignal(deploymentId: string): Promise<boolean> {
  try {
    const value = await redis.get(KILL_KEY(deploymentId));
    return value !== null;
  } catch {
    return false;
  }
}

async function clearKillSignal(deploymentId: string): Promise<void> {
  try {
    await redis.del(KILL_KEY(deploymentId));
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Public API for user-initiated cancellation
// ---------------------------------------------------------------------------

/**
 * TTL for the kill signal. It outlives any single phase — a cold build holds one
 * stage for minutes, and at 60s the signal expired before it could be read.
 */
const KILL_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** How often a running deploy re-reads its kill key between stage transitions. */
const KILL_POLL_MS = 3000;

/**
 * Signal a running deployment to stop. Consumed within seconds during a safe
 * stage, otherwise at the next stage boundary.
 */
export async function publishKillSignal(deploymentId: string): Promise<void> {
  await redis.set(KILL_KEY(deploymentId), "1", "PX", KILL_TTL_MS);
}

/**
 * Whether the registry still names this deployment as the app's active deploy.
 * "unknown" whenever Redis cannot answer — callers must not read that as dead.
 */
export async function deployRegistration(
  appId: string,
  deploymentId: string,
): Promise<"active" | "gone" | "unknown"> {
  try {
    const row = await db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
      columns: { environmentId: true },
    });
    const raw = await redis.get(ACTIVE_KEY(await deployScope(appId, row?.environmentId)));
    if (!raw) return "gone";
    const entry = JSON.parse(raw) as { deploymentId: string };
    return entry.deploymentId === deploymentId ? "active" : "gone";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Entry point for all deploys. Replaces direct `deployProject()` calls.
 *
 * Creates the deployment record, cancels or waits for any in-progress deploy
 * for the same app, then runs the new deploy.
 *
 * Works across multiple Node processes: the active-deploy state is mirrored
 * to Redis so that a process starting a new deploy can detect and signal a
 * deploy running in a different process.
 */
export async function requestDeploy(opts: DeployOpts): Promise<DeployResult> {
  const newDeploymentId = opts.deploymentId ?? await createDeployment(opts);
  const scope = await deployScope(opts.appId, opts.environmentId);

  // This process is about to be stopped by a Vardo self-deploy. Checked before
  // the registry below, which would otherwise supersede a deploy it must wait for.
  if (draining) {
    const message = "Vardo is restarting to finish an update — retry the deploy in a minute";
    const now = new Date();
    await db
      .update(deployments)
      .set({ status: "cancelled", log: `[${now.toISOString()}] [CANCELLED] ${message}`, finishedAt: now })
      .where(eq(deployments.id, newDeploymentId))
      .catch((dbErr) => log.warn("Failed to record refused deployment:", dbErr));
    throw new DeployBlockedError(message);
  }

  // ------------------------------------------------------------------
  // 1. Check in-process registry first (same process — direct control)
  // ------------------------------------------------------------------
  const localExisting = localRegistry.get(scope);
  if (localExisting) {
    if (SAFE_CANCEL_STAGES.has(localExisting.stage)) {
      localExisting.controller.abort({ supersededBy: newDeploymentId });
    }
    await localExisting.done.catch(() => {});
  } else {
    // ------------------------------------------------------------------
    // 2. Check Redis for a deploy owned by a different process
    // ------------------------------------------------------------------
    const redisEntry = await getActiveFromRedis(scope);
    if (redisEntry) {
      if (SAFE_CANCEL_STAGES.has(redisEntry.stage)) {
        // Signal the remote process to cancel
        await writeCancelSignal(scope, newDeploymentId);
      }

      // Poll until the foreign deploy clears (or times out). Its lease is
      // renewed only while its process lives, so a dead owner clears itself.
      opts.onLog?.("[queue] Waiting for the deploy already running for this app");
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const still = await getActiveFromRedis(scope);
        if (!still) break;
        await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. Register THIS deploy in both the local map and Redis
  // ------------------------------------------------------------------
  const controller = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const active: ActiveDeploy = {
    deploymentId: newDeploymentId,
    controller,
    stage: "clone",
    done,
  };
  localRegistry.set(scope, active);
  await setActiveInRedis(scope, newDeploymentId, "clone");

  // Stage transitions are minutes apart during a build, so they cannot carry
  // the lease on their own.
  const leaseRenew = setInterval(() => {
    renewActiveLease(scope, newDeploymentId, active.stage).catch(() => {});
  }, ACTIVE_HEARTBEAT_MS);
  leaseRenew.unref?.();

  // Stage transitions are minutes apart during a build, so the kill key is also
  // polled. Only while nothing is serving from this deploy — past that point the
  // abort is left to the next stage boundary, where the teardown path runs.
  const killPoll = setInterval(() => {
    if (controller.signal.aborted || !SAFE_CANCEL_STAGES.has(active.stage)) return;
    checkKillSignal(newDeploymentId)
      .then(async (killed) => {
        if (!killed || controller.signal.aborted) return;
        await clearKillSignal(newDeploymentId);
        controller.abort({ killed: true });
      })
      .catch(() => {});
  }, KILL_POLL_MS);
  killPoll.unref?.();

  // ------------------------------------------------------------------
  // 4. Acquire a system-level concurrency slot (FIFO queue)
  //
  // Guarantees at most VARDO_MAX_DEPLOY_CONCURRENCY deploys run at once
  // across all apps. Deploys beyond the limit wait in FIFO order until a
  // slot opens. The queue is backed by Redis and survives process restarts
  // (the sweeper marks orphaned queued records as cancelled on recovery).
  // ------------------------------------------------------------------
  let concurrencySlotHeld = false;
  try {
    const immediate = await enqueueAndTryAcquire(newDeploymentId);
    if (!immediate) {
      const limit = getConcurrencyLimit();
      opts.onLog?.(
        `[queue] Waiting for a concurrency slot (${limit} max simultaneous deploy${limit === 1 ? "" : "s"})`,
      );
      await waitForConcurrencySlot(newDeploymentId, controller.signal);
      opts.onLog?.("[queue] Concurrency slot acquired — starting deploy");
    }
    concurrencySlotHeld = true;

    const result = await runDeployment(newDeploymentId, {
      ...opts,
      signal: controller.signal,
      onStage: async (stage, status) => {
        // Keep local registry up to date
        active.stage = stage;
        await renewActiveLease(scope, newDeploymentId, stage);

        // Check for a user-initiated kill signal (cancel running deployment via API)
        if (!controller.signal.aborted) {
          const killed = await checkKillSignal(newDeploymentId);
          if (killed) {
            await clearKillSignal(newDeploymentId);
            controller.abort({ killed: true });
          }
        }

        // Check for a cross-process cancel signal written by another process
        if (!controller.signal.aborted) {
          const cancelSignal = await checkCancelSignal(scope);
          if (cancelSignal) {
            // Consume the signal
            await clearCancelSignal(scope);
            if (SAFE_CANCEL_STAGES.has(stage)) {
              controller.abort({ supersededBy: cancelSignal.supersededBy });
            }
          }
        }

        opts.onStage?.(stage, status);
      },
    });
    return result;
  } catch (err) {
    // If the deploy never started (e.g. queue timeout or cancelled while waiting),
    // remove from the queue so the slot isn't leaked and immediately update the
    // DB record to cancelled. Without this the record stays in "queued" status
    // until sweepStuckQueuedDeployments fires (~30 min default), leaving users
    // with no real-time feedback.
    if (!concurrencySlotHeld) {
      await removeFromQueue(newDeploymentId).catch(() => {});
      const now = new Date();
      const errorMessage = err instanceof Error ? err.message : String(err);
      await db
        .update(deployments)
        .set({
          status: "cancelled",
          log: `[${now.toISOString()}] [CANCELLED] ${errorMessage}`,
          finishedAt: now,
        })
        .where(and(eq(deployments.id, newDeploymentId), eq(deployments.status, "queued")))
        .catch((dbErr) => log.warn("Failed to update cancelled deployment status:", dbErr));
    }
    throw err;
  } finally {
    clearInterval(killPoll);
    clearInterval(leaseRenew);
    await clearKillSignal(newDeploymentId);
    if (concurrencySlotHeld) {
      await releaseConcurrencySlot(newDeploymentId);
    }
    // Only remove from the local registry if we are still the active deploy for
    // this app. A deploy that started after us may have already replaced the
    // entry (e.g. rapid pushes).
    if (localRegistry.get(scope) === active) {
      localRegistry.delete(scope);
    }
    await clearActiveInRedis(scope, newDeploymentId);
    resolveDone();
  }
}
