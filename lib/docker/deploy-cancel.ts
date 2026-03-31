// ---------------------------------------------------------------------------
// Per-app deploy cancel-and-replace
//
// Ensures only one deploy runs per app at a time. When a new deploy arrives
// for an app that is already deploying:
//
//   - Pre-build stages (clone, build): cancel the in-progress deploy
//     immediately by aborting the child process group. Mark the old deploy
//     as "superseded". Start the new deploy right away.
//
//   - Post-build stages (deploy, healthcheck, routing, cleanup): let the
//     current deploy finish — it is already serving traffic or about to.
//     The new deploy starts as soon as the current one completes.
//
// Cross-process registry
// ----------------------
// The active-deploy state is kept in both an in-process Map (for AbortController
// and the "done" promise) AND in Redis (for cross-process visibility).
//
//   deploy:active:{appId}   — JSON: { deploymentId, stage }  TTL: 30 min
//   deploy:cancel:{appId}   — JSON: { supersededBy }         TTL: 60 s
//
// When a new deploy arrives and finds a Redis entry owned by another process it
// writes deploy:cancel:{appId} and polls until the entry clears (up to 2 min).
// Each process checks deploy:cancel:{appId} at every stage transition and aborts
// its local controller when it finds a cancellation request for its deployment.
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema/apps";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { createDeployment, runDeployment } from "./deploy";
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

const ACTIVE_KEY = (appId: string) => `deploy:active:${appId}`;
const CANCEL_KEY = (appId: string) => `deploy:cancel:${appId}`;
const KILL_KEY = (deploymentId: string) => `deploy:kill:${deploymentId}`;

/** TTL for the active-deploy registry entry — acts as a safety-net expiry. */
const ACTIVE_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

// ---------------------------------------------------------------------------
// Stages where it is safe to cancel — the build has not yet produced output
// or started routing traffic.
// ---------------------------------------------------------------------------

const PRE_BUILD_STAGES = new Set<DeployStage>(["clone", "build"]);

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

async function updateStageInRedis(
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

async function clearActiveInRedis(appId: string, deploymentId: string): Promise<void> {
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

/** TTL for the kill signal — short-lived; consumed at the next stage transition. */
const KILL_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Signal a running deployment to stop at the next stage boundary.
 * Called by the API when a user cancels a deployment that is already running.
 */
export async function publishKillSignal(deploymentId: string): Promise<void> {
  await redis.set(KILL_KEY(deploymentId), "1", "PX", KILL_TTL_MS);
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
  const { appId } = opts;
  const newDeploymentId = opts.deploymentId ?? await createDeployment(opts);

  // ------------------------------------------------------------------
  // 1. Check in-process registry first (same process — direct control)
  // ------------------------------------------------------------------
  const localExisting = localRegistry.get(appId);
  if (localExisting) {
    if (PRE_BUILD_STAGES.has(localExisting.stage)) {
      localExisting.controller.abort({ supersededBy: newDeploymentId });
    }
    await localExisting.done.catch(() => {});
  } else {
    // ------------------------------------------------------------------
    // 2. Check Redis for a deploy owned by a different process
    // ------------------------------------------------------------------
    const redisEntry = await getActiveFromRedis(appId);
    if (redisEntry) {
      if (PRE_BUILD_STAGES.has(redisEntry.stage)) {
        // Signal the remote process to cancel
        await writeCancelSignal(appId, newDeploymentId);
      }

      // Poll until the foreign deploy clears (or times out)
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const still = await getActiveFromRedis(appId);
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
  localRegistry.set(appId, active);
  await setActiveInRedis(appId, newDeploymentId, "clone");

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
        // Mirror stage to Redis
        await updateStageInRedis(appId, newDeploymentId, stage);

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
          const cancelSignal = await checkCancelSignal(appId);
          if (cancelSignal) {
            // Consume the signal
            await clearCancelSignal(appId);
            if (PRE_BUILD_STAGES.has(stage)) {
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
    if (concurrencySlotHeld) {
      await releaseConcurrencySlot();
    }
    // Only remove from the local registry if we are still the active deploy for
    // this app. A deploy that started after us may have already replaced the
    // entry (e.g. rapid pushes).
    if (localRegistry.get(appId) === active) {
      localRegistry.delete(appId);
    }
    await clearActiveInRedis(appId, newDeploymentId);
    resolveDone();
  }
}
