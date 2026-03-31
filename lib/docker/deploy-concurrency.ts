// ---------------------------------------------------------------------------
// System-level deploy concurrency queue
//
// Ensures at most N deploys run simultaneously across all apps. New deploys
// beyond the limit queue in FIFO order and start as slots open.
//
// Redis keys:
//   deploy:system:active   — integer counter of currently running deploys
//   deploy:system:queue    — Redis list of deploymentId strings (RPUSH / LPOP)
//
// A deploy acquires a slot by:
//   1. Pushing its deploymentId to the tail of the queue (RPUSH).
//   2. Atomically checking: is it at the head AND is active < limit?
//      - Yes → remove from head, increment active, proceed immediately.
//      - No  → poll every POLL_INTERVAL_MS until the check passes.
//
// When a deploy finishes it decrements the active counter. The next deploy at
// the head of the queue will notice on its next poll and take the slot.
//
// Fail-safe: if Redis is unreachable all operations are non-fatal and deploys
// proceed without concurrency enforcement (same behavior as before this feature).
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

const log = logger.child("deploy-concurrency");

// ---------------------------------------------------------------------------
// Redis keys
// ---------------------------------------------------------------------------

export const ACTIVE_KEY = "deploy:system:active";
export const QUEUE_KEY = "deploy:system:queue";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Poll interval while a deploy waits in the concurrency queue. */
const POLL_INTERVAL_MS = 250;

/**
 * Max time a deploy will wait for a concurrency slot before giving up.
 * Set slightly below the SSE stream timeout (10 min) so the error is clean.
 */
const QUEUE_TIMEOUT_MS = 9 * 60 * 1000; // 9 minutes

export function getConcurrencyLimit(): number {
  const parsed = parseInt(process.env.VARDO_MAX_DEPLOY_CONCURRENCY ?? "2", 10);
  return Math.max(1, isNaN(parsed) ? 2 : parsed);
}

// ---------------------------------------------------------------------------
// Lua scripts — all key mutations are atomic to prevent double-acquisition
// ---------------------------------------------------------------------------

/**
 * Try to advance the deploy at the head of the FIFO queue.
 *
 * If KEYS[1][0] (queue head) === ARGV[1] (deploymentId) AND
 *    get(KEYS[2]) (active count) < ARGV[2] (limit):
 *   - Pop head of queue
 *   - Increment active counter
 *   - Return 1 (acquired)
 * Otherwise return 0.
 *
 * KEYS[1] = queue list key
 * KEYS[2] = active counter key
 * ARGV[1] = deploymentId
 * ARGV[2] = limit (string)
 */
const LUA_TRY_ADVANCE = `
  local head = redis.call('lindex', KEYS[1], 0)
  if head ~= ARGV[1] then return 0 end
  local active = tonumber(redis.call('get', KEYS[2])) or 0
  if active >= tonumber(ARGV[2]) then return 0 end
  redis.call('lpop', KEYS[1])
  redis.call('set', KEYS[2], tostring(active + 1))
  return 1
`;

/**
 * Decrement the active counter, flooring at zero.
 *
 * KEYS[1] = active counter key
 */
const LUA_RELEASE = `
  local active = tonumber(redis.call('get', KEYS[1])) or 0
  if active > 0 then
    redis.call('set', KEYS[1], tostring(active - 1))
    return active - 1
  end
  return 0
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a deployment to the FIFO queue and immediately attempt to acquire a
 * concurrency slot.
 *
 * Returns true if the slot was acquired immediately (the deploy can start
 * right away), or false if the deploy must wait — call waitForConcurrencySlot()
 * and then proceed once it resolves.
 *
 * Non-fatal: returns true (no limit enforced) if Redis is unreachable.
 */
export async function enqueueAndTryAcquire(deploymentId: string): Promise<boolean> {
  const limit = getConcurrencyLimit();
  try {
    await redis.rpush(QUEUE_KEY, deploymentId);
    const result = await redis.eval(
      LUA_TRY_ADVANCE,
      2,
      QUEUE_KEY,
      ACTIVE_KEY,
      deploymentId,
      String(limit),
    );
    return result === 1;
  } catch (err) {
    log.warn("Redis unavailable in enqueueAndTryAcquire — skipping concurrency limit:", err);
    return true;
  }
}

/**
 * Poll until this deployment reaches the head of the queue and a concurrency
 * slot is free, then atomically take the slot.
 *
 * Throws if the AbortSignal fires or the queue timeout (9 min) expires.
 * On throw, the deployment is removed from the queue automatically.
 */
export async function waitForConcurrencySlot(
  deploymentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const limit = getConcurrencyLimit();
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;

  while (true) {
    if (signal?.aborted) {
      await removeFromQueue(deploymentId).catch(() => {});
      throw new Error("Deploy cancelled while waiting in concurrency queue");
    }

    if (Date.now() >= deadline) {
      await removeFromQueue(deploymentId).catch(() => {});
      throw new Error(
        "Deploy queue timeout — waited too long for a concurrency slot",
      );
    }

    try {
      const result = await redis.eval(
        LUA_TRY_ADVANCE,
        2,
        QUEUE_KEY,
        ACTIVE_KEY,
        deploymentId,
        String(limit),
      );
      if (result === 1) return; // Slot acquired
    } catch (err) {
      // Redis hiccup — proceed without enforcement rather than blocking forever
      log.warn("Redis error while polling for concurrency slot — proceeding without enforcement:", err);
      return;
    }

    const jitter = Math.random() * POLL_INTERVAL_MS;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS + jitter));
  }
}

/**
 * Release one concurrency slot. Must be called exactly once after a deploy
 * that successfully acquired a slot finishes (success, failure, or cancellation).
 */
export async function releaseConcurrencySlot(): Promise<void> {
  try {
    await redis.eval(LUA_RELEASE, 1, ACTIVE_KEY);
  } catch (err) {
    log.warn("Failed to release concurrency slot — counter may drift until next reconciliation:", err);
  }
}

/**
 * Remove a specific deploymentId from the queue (best-effort).
 * Used when a queued deploy is cancelled before it acquires a slot.
 */
export async function removeFromQueue(deploymentId: string): Promise<void> {
  try {
    await redis.lrem(QUEUE_KEY, 0, deploymentId);
  } catch (err) {
    log.warn(`Failed to remove deployment ${deploymentId} from concurrency queue:`, err);
  }
}

// ---------------------------------------------------------------------------
// Observability + reconciliation
// ---------------------------------------------------------------------------

/**
 * Return the current concurrency state for health checks and admin UI.
 */
export async function getConcurrencyState(): Promise<{
  active: number;
  limit: number;
  queued: number;
  queuedIds: string[];
}> {
  try {
    const [activeRaw, queued, queuedIds] = await Promise.all([
      redis.get(ACTIVE_KEY),
      redis.llen(QUEUE_KEY),
      redis.lrange(QUEUE_KEY, 0, -1),
    ]);
    return {
      active: Math.max(0, parseInt(activeRaw ?? "0", 10)),
      limit: getConcurrencyLimit(),
      queued,
      queuedIds,
    };
  } catch {
    return { active: 0, limit: getConcurrencyLimit(), queued: 0, queuedIds: [] };
  }
}

/**
 * Reconcile the Redis queue against a set of deployment IDs that are legitimately
 * queued or running. Removes any orphaned entries — e.g. an ID pushed by
 * enqueueAndTryAcquire whose subsequent eval threw, leaving a ghost at the queue
 * head that would block all subsequent deploys until the 9-min poll timeout.
 *
 * Safe to call at any time — only removes entries not present in activeIds.
 */
export async function reconcileQueue(activeIds: Set<string>): Promise<void> {
  try {
    const queued = await redis.lrange(QUEUE_KEY, 0, -1);
    const orphaned = queued.filter((id) => !activeIds.has(id));
    await Promise.all(
      orphaned.map(async (id) => {
        await redis.lrem(QUEUE_KEY, 0, id);
        log.warn(`Removed orphaned concurrency queue entry for deployment ${id}`);
      }),
    );
  } catch (err) {
    log.warn("Failed to reconcile concurrency queue:", err);
  }
}

/**
 * Reconcile the active counter against the number of deployments currently in
 * "running" status in the database. Called by the deploy sweeper after it cleans
 * up stuck deployments to prevent the counter from drifting above the true count.
 *
 * Safe to call at any time — only updates if the counter is out of sync.
 */
export async function reconcileActiveCounter(runningDeployCount: number): Promise<void> {
  try {
    const activeRaw = await redis.get(ACTIVE_KEY);
    const active = parseInt(activeRaw ?? "0", 10);
    const limit = getConcurrencyLimit();
    const expected = Math.min(runningDeployCount, limit);

    if (active !== expected) {
      log.warn(
        `Reconciling deploy concurrency counter: stored=${active}, expected=${expected}`,
      );
      if (expected === 0) {
        await redis.del(ACTIVE_KEY);
      } else {
        await redis.set(ACTIVE_KEY, String(expected));
      }
    }
  } catch (err) {
    log.warn("Failed to reconcile active deploy counter:", err);
  }
}
