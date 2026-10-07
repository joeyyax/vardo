// System-wide FIFO deploy queue: at most N deploys at once, tracked by deploy:system:active and deploy:system:queue.
// If Redis is unreachable deploys proceed without a limit.

import { redis } from "@/lib/redis";
import { acquireLock } from "@/lib/redis-lock";
import { logger } from "@/lib/logger";

const log = logger.child("deploy-concurrency");

export const ACTIVE_KEY = "deploy:system:active";
export const QUEUE_KEY = "deploy:system:queue";

/** Marker proving a deployment's slot has already been released. */
const releasedKey = (deploymentId: string) => `deploy:system:released:${deploymentId}`;
const RELEASED_TTL_MS = 60 * 60_000;

/** Poll interval while a deploy waits in the concurrency queue. */
const POLL_INTERVAL_MS = 250;

/** Max wait for a slot. Below the 10-minute SSE stream timeout so the error is clean. */
const QUEUE_TIMEOUT_MS = 9 * 60 * 1000; // 9 minutes

export function getConcurrencyLimit(): number {
  const parsed = parseInt(process.env.VARDO_MAX_DEPLOY_CONCURRENCY ?? "2", 10);
  return Math.max(1, isNaN(parsed) ? 2 : parsed);
}

// Lua scripts keep key mutations atomic, preventing double acquisition.

/**
 * Pop the queue head and increment active when the head is this deployment and active < limit. Returns 1 if acquired.
 * KEYS: queue, active counter. ARGV: deploymentId, limit.
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

/** Decrement the active counter, flooring at zero. KEYS[1] = active counter. */
const LUA_RELEASE = `
  local active = tonumber(redis.call('get', KEYS[1])) or 0
  if active > 0 then
    redis.call('set', KEYS[1], tostring(active - 1))
    return active - 1
  end
  return 0
`;

/** Enqueue a deployment and try for a slot. False means call waitForConcurrencySlot(). True without Redis. */
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

/** Poll until this deployment heads the queue with a free slot, then take it. Throws on abort or timeout, leaving the queue. */
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
      // Redis hiccup: proceed without enforcement.
      log.warn("Redis error while polling for concurrency slot — proceeding without enforcement:", err);
      return;
    }

    const jitter = Math.random() * POLL_INTERVAL_MS;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS + jitter));
  }
}

/** Release a deploy's slot. With a deploymentId it applies at most once, so force-cancel and unwind can't both decrement. */
export async function releaseConcurrencySlot(deploymentId?: string): Promise<void> {
  try {
    if (deploymentId && !(await acquireLock(releasedKey(deploymentId), RELEASED_TTL_MS))) {
      return;
    }
    await redis.eval(LUA_RELEASE, 1, ACTIVE_KEY);
  } catch (err) {
    log.warn("Failed to release concurrency slot — counter may drift until next reconciliation:", err);
  }
}

/** Remove a cancelled deployment from the queue (best effort). */
export async function removeFromQueue(deploymentId: string): Promise<void> {
  try {
    await redis.lrem(QUEUE_KEY, 0, deploymentId);
  } catch (err) {
    log.warn(`Failed to remove deployment ${deploymentId} from concurrency queue:`, err);
  }
}

/** Current concurrency state for health checks and the admin UI. */
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

/** Whether the caller is the last deploy running with nothing queued, so host-global cleanup is safe. */
// Fails closed: a Redis error reports "not drained".
export async function isDeployQueueDrained(): Promise<boolean> {
  try {
    const [activeRaw, queued] = await Promise.all([
      redis.get(ACTIVE_KEY),
      redis.llen(QUEUE_KEY),
    ]);
    const active = Math.max(0, parseInt(activeRaw ?? "0", 10));
    return active <= 1 && queued === 0;
  } catch {
    return false;
  }
}

/** Drop queue entries not in activeIds, e.g. a ghost head left by a failed enqueue that blocks every deploy. */
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

/** Set the active counter to the running deploy count from the database when they drift. */
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
