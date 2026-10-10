// Serializes use of an app's shared checkout, which every environment fetches into.

import { randomUUID } from "crypto";

const LEASE_MS = 60_000;
const RENEW_MS = 20_000;
const POLL_MS = 500;
/** A deploy waits behind another's checkout for at most this long. */
export const CHECKOUT_LOCK_WAIT_MS = 15 * 60_000;

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

/** The subset of ioredis the lock uses. */
export type LockRedis = {
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<unknown>;
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
};

export type CheckoutLock = { release: () => Promise<void> };

const local = new Map<string, Promise<void>>();

async function defaultRedis(): Promise<LockRedis> {
  const { redis } = await import("@/lib/redis");
  return redis as unknown as LockRedis;
}

const WAITING = "[deploy] Waiting for another deploy of this app to finish with the repository checkout";
const TIMED_OUT = "Timed out waiting for another deploy's repository checkout";

/** Resolves with `p`, or rejects at the timeout or on abort. Clears its timer either way. */
function within(p: Promise<void> | null, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Deployment aborted"));
    const onAbort = () => finish(new Error("Deployment aborted"));
    const t = setTimeout(() => (p ? finish(new Error(TIMED_OUT)) : finish()), Math.max(0, ms));
    function finish(err?: Error) {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    p?.then(() => finish());
  });
}

const sleep = (ms: number, signal?: AbortSignal) => within(null, ms, signal);

/**
 * Takes the app's checkout lock: in-process first, then a Redis lease for other processes.
 * Redis being down degrades to the in-process lock.
 */
export async function acquireCheckoutLock(appId: string, opts: {
  log: (line: string) => void;
  signal?: AbortSignal;
  waitMs?: number;
  redis?: () => Promise<LockRedis>;
}): Promise<CheckoutLock> {
  const waitMs = opts.waitMs ?? CHECKOUT_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;

  // Chain behind the in-process holder.
  const prev = local.get(appId);
  let releaseLocal!: () => void;
  const mine = new Promise<void>((r) => (releaseLocal = r));
  const chained = (prev ?? Promise.resolve()).then(() => mine);
  local.set(appId, chained);
  const dropLocal = () => {
    releaseLocal();
    if (local.get(appId) === chained) local.delete(appId);
  };

  let waited = false;
  if (prev) {
    waited = true;
    opts.log(WAITING);
    try {
      await within(prev, deadline - Date.now(), opts.signal);
    } catch (err) {
      dropLocal();
      throw err;
    }
  }

  const key = `deploy:checkout:${appId}`;
  const token = randomUUID();
  let redis: LockRedis | null = null;
  try {
    redis = await (opts.redis ?? defaultRedis)();
  } catch {
    redis = null;
  }
  while (redis) {
    let taken: unknown;
    try {
      taken = await redis.set(key, token, "PX", LEASE_MS, "NX");
    } catch {
      redis = null;
      break;
    }
    if (taken === "OK") break;
    if (!waited) {
      waited = true;
      opts.log(WAITING);
    }
    try {
      if (Date.now() >= deadline) throw new Error(TIMED_OUT);
      await sleep(POLL_MS, opts.signal);
    } catch (err) {
      dropLocal();
      throw err;
    }
  }
  if (!redis) opts.log("[deploy] Warning: couldn't take the checkout lock in Redis; serializing in this process only");

  const held = redis;
  const renew = held
    ? setInterval(() => {
        held.eval(RENEW, 1, key, token, String(LEASE_MS)).catch(() => {});
      }, RENEW_MS)
    : null;
  renew?.unref?.();

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      if (renew) clearInterval(renew);
      if (held) await held.eval(RELEASE, 1, key, token).catch(() => {});
      dropLocal();
    },
  };
}
