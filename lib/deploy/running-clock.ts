// The sweeper's running clock for a deploy, which time spent waiting doesn't count against.

import { redis } from "@/lib/redis";

/** When the sweeper first saw a deployment in "running", in epoch ms. */
export const runningSinceKey = (deploymentId: string) => `deploy:sweep:running-since:${deploymentId}`;

/** How often a waiting deploy moves its mark forward. */
export const CLOCK_SHIFT_MS = 10_000;

// Only an existing mark moves; INCRBY on a missing key would create a tiny timestamp the sweeper reads as overdue.
const SHIFT = `if redis.call('exists', KEYS[1]) == 1 then return redis.call('incrby', KEYS[1], ARGV[1]) end return 0`;

/** Stops the clock while a deploy waits by moving its mark forward as the wait goes on. Durations only, so clocks needn't agree. */
export function pauseRunningClock(deploymentId: string, opts: { everyMs?: number; client?: Pick<typeof redis, "eval"> } = {}): {
  resume: () => Promise<void>;
} {
  const client = opts.client ?? redis;
  let last = Date.now();
  const shift = async () => {
    const now = Date.now();
    const by = now - last;
    last = now;
    if (by <= 0) return;
    try {
      await client.eval(SHIFT, 1, runningSinceKey(deploymentId), String(by));
    } catch { /* the clock runs on; the sweeper's budget still applies */ }
  };
  const timer = setInterval(() => void shift(), opts.everyMs ?? CLOCK_SHIFT_MS);
  timer.unref?.();
  return {
    resume: async () => {
      clearInterval(timer);
      await shift();
    },
  };
}
