// One deploy per app environment: safe stages (clone, compose, build) are superseded, swap stages finish first.
// State lives in a local Map and in Redis (deploy:active lease, deploy:cancel signal) for cross-process cancels.

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

/** Registry key: appId for the default environment (or anything unresolved), `${appId}:${environmentId}` otherwise. */
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
const WORKER_KEY = (deploymentId: string) => `deploy:worker:${deploymentId}`;

/** Lease on the active-deploy entry, renewed while the owner runs. A dead process (e.g. a self-deploy) releases it within the lease. */
export const ACTIVE_TTL_MS = 30 * 1000;

/** Renewal interval. Three beats fit inside the lease. */
export const ACTIVE_HEARTBEAT_MS = 10 * 1000;

/** TTL for the cancel signal. */
const CANCEL_TTL_MS = 60 * 1000; // 60 seconds

/** How long to wait for a foreign deploy to finish. */
const WAIT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Poll interval while waiting for a foreign deploy to clear. */
const WAIT_POLL_MS = 250;

// In-process registry: AbortController and done promise can't cross processes.

type ActiveDeploy = {
  deploymentId: string;
  controller: AbortController;
  stage: DeployStage;
  // Resolves when the deploy finishes, fails or is cancelled.
  done: Promise<void>;
};

// Deploys owned by this process.
const localRegistry = new Map<string, ActiveDeploy>();

/** Set once a self-deploy starts draining this process before stopping it. */
let draining = false;

/** Upper bound on how long a self-deploy waits for this process's other deploys. */
export const SELF_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

const SELF_DRAIN_POLL_MS = 1000;

/** Hold a self-deploy's final stop until this process's other deploys finish. Refuses new deploys; returns those still running at the deadline. */
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

/** Take deploys again after a self-deploy's stop failed. */
export function endSelfDrain(): void {
  draining = false;
}

/** Test hook. */
export function resetDrainForTests(): void {
  draining = false;
  localRegistry.clear();
}

/** Whether a deploy of this app is running or queued in any process. "unknown" when Redis can't answer and nothing runs locally. */
export async function deployInFlight(appId: string): Promise<boolean | "unknown"> {
  if (localRegistry.has(appId)) return true;
  try {
    return (await redis.get(ACTIVE_KEY(appId))) !== null;
  } catch {
    return "unknown";
  }
}

/** Claim the app's active-deploy key for a non-deploy operation (e.g. instant rollback). Null when the app is busy. */
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

// Stages where a cancel costs nothing: the previous slot is still serving.

export const SAFE_CANCEL_STAGES = new Set<DeployStage>(["clone", "compose", "build"]);

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
    // Non-fatal: the in-process registry still works.
  }
}

export async function renewActiveLease(
  appId: string,
  deploymentId: string,
  stage: DeployStage
): Promise<void> {
  try {
    // Only if this deploy still owns the key.
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
    // Only if this deploy still owns it.
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

/** TTL for the kill signal. Outlives a cold build's single stage. */
const KILL_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** How often a running deploy re-reads its kill key between stage transitions. */
const KILL_POLL_MS = 3000;

/** Signal a running deployment to stop: within seconds in a safe stage, else at the next stage boundary. */
export async function publishKillSignal(deploymentId: string): Promise<void> {
  await redis.set(KILL_KEY(deploymentId), "1", "PX", KILL_TTL_MS);
}

/** Whether the registry still names this deployment as the app's active deploy. "unknown" is not dead. */
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

async function renewWorkerLease(deploymentId: string): Promise<void> {
  try {
    await redis.set(WORKER_KEY(deploymentId), "1", "PX", ACTIVE_TTL_MS);
  } catch {
    // Non-fatal: the sweeper reads a missing Redis as unknown.
  }
}

async function clearWorkerLease(deploymentId: string): Promise<void> {
  try {
    await redis.del(WORKER_KEY(deploymentId));
  } catch {
    // Expires on its own.
  }
}

/** Whether a live process still owns this deployment. "unknown" is not dead. */
export async function deployWorker(deploymentId: string): Promise<"live" | "gone" | "unknown"> {
  try {
    return (await redis.get(WORKER_KEY(deploymentId))) !== null ? "live" : "gone";
  } catch {
    return "unknown";
  }
}

/** Entry point for all deploys: create the record, cancel or wait for any in-progress deploy of the app (across processes), then run. */
export async function requestDeploy(opts: DeployOpts): Promise<DeployResult> {
  const newDeploymentId = opts.deploymentId ?? await createDeployment(opts);

  // A self-deploy is about to stop this process. Checked before the registry, which would supersede a deploy it must wait for.
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

  // Leased for the whole request, so the sweeper can tell a waiting deploy from one whose process died.
  await renewWorkerLease(newDeploymentId);
  const workerRenew = setInterval(() => {
    renewWorkerLease(newDeploymentId).catch(() => {});
  }, ACTIVE_HEARTBEAT_MS);
  workerRenew.unref?.();

  try {
    return await runRequestedDeploy(newDeploymentId, opts);
  } finally {
    clearInterval(workerRenew);
    await clearWorkerLease(newDeploymentId);
  }
}

// Claims per scope run one at a time in this process, so a burst can't all find the registry empty.
const claimChains = new Map<string, Promise<unknown>>();

function oneClaimAtATime<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const next = (claimChains.get(scope) ?? Promise.resolve()).then(fn, fn);
  const settled = next.then(
    () => {},
    () => {},
  );
  claimChains.set(scope, settled);
  void settled.then(() => {
    if (claimChains.get(scope) === settled) claimChains.delete(scope);
  });
  return next;
}

/** Takes the scope's Redis key with NX, superseding or waiting out its owner. Overwrites at the deadline, as a dead owner would have let it lapse. */
async function claimActiveInRedis(scope: string, deploymentId: string, onLog?: (line: string) => void): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const value = JSON.stringify({ deploymentId, stage: "clone" });
  let signalled: string | null = null;
  let announced = false;
  for (;;) {
    try {
      if ((await redis.set(ACTIVE_KEY(scope), value, "PX", ACTIVE_TTL_MS, "NX")) === "OK") return;
    } catch {
      // Redis down: the in-process registry is all there is.
      return;
    }
    const entry = await getActiveFromRedis(scope);
    if (entry && entry.deploymentId !== signalled && SAFE_CANCEL_STAGES.has(entry.stage)) {
      await writeCancelSignal(scope, deploymentId);
      signalled = entry.deploymentId;
    }
    if (!announced) {
      onLog?.("[queue] Waiting for the deploy already running for this app");
      announced = true;
    }
    if (Date.now() >= deadline) {
      await setActiveInRedis(scope, deploymentId, "clone");
      return;
    }
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

async function runRequestedDeploy(newDeploymentId: string, opts: DeployOpts): Promise<DeployResult> {
  const scope = await deployScope(opts.appId, opts.environmentId);

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

  await oneClaimAtATime(scope, async () => {
    // 1. Same-process deploy.
    const localExisting = localRegistry.get(scope);
    if (localExisting) {
      if (SAFE_CANCEL_STAGES.has(localExisting.stage)) {
        localExisting.controller.abort({ supersededBy: newDeploymentId });
      }
      await localExisting.done.catch(() => {});
    }

    // 2. Deploy owned by another process. Its lease renews only while its process lives, so a dead owner clears itself.
    await claimActiveInRedis(scope, newDeploymentId, opts.onLog);

    // 3. Register this deploy locally.
    localRegistry.set(scope, active);
  });

  // Stage transitions are minutes apart during a build, so they can't carry the lease alone.
  const leaseRenew = setInterval(() => {
    renewActiveLease(scope, newDeploymentId, active.stage).catch(() => {});
  }, ACTIVE_HEARTBEAT_MS);
  leaseRenew.unref?.();

  // Kill key is polled too, but only while nothing serves from this deploy. After that the next stage boundary handles teardown.
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

  // 4. System-wide FIFO slot (VARDO_MAX_DEPLOY_CONCURRENCY), Redis-backed.
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
        active.stage = stage;
        await renewActiveLease(scope, newDeploymentId, stage);

        // User-initiated kill via API.
        if (!controller.signal.aborted) {
          const killed = await checkKillSignal(newDeploymentId);
          if (killed) {
            await clearKillSignal(newDeploymentId);
            controller.abort({ killed: true });
          }
        }

        // Cross-process cancel signal.
        if (!controller.signal.aborted) {
          const cancelSignal = await checkCancelSignal(scope);
          if (cancelSignal) {
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
    // Never started (queue timeout or cancelled while waiting): free the queue entry and mark the record cancelled now.
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
    // A newer deploy may have replaced the entry already.
    if (localRegistry.get(scope) === active) {
      localRegistry.delete(scope);
    }
    await clearActiveInRedis(scope, newDeploymentId);
    resolveDone();
  }
}
