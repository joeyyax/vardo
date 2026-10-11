// Runs the host reclaim once deploys go quiet, and nightly as a backstop. Disk pressure runs it from the alert pass.

import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import type { ReclaimTrigger } from "./state";

const log = logger.child("host-reclaim");

const CHECK_INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 10 * 60_000;
/** Quiet time after the last deploy, so a burst of deploys reclaims once. */
export const DEPLOY_SETTLE_MS = 10 * 60_000;
export const NIGHTLY_MS = 24 * 60 * 60_000;

/** Which trigger is due, or null. Pure. */
export function dueTrigger(input: {
  now: number;
  lastRunAt: number | null;
  lastDeployAt: number | null;
}): ReclaimTrigger | null {
  const { now, lastRunAt, lastDeployAt } = input;
  if (lastDeployAt !== null && (lastRunAt === null || lastDeployAt > lastRunAt) && now - lastDeployAt >= DEPLOY_SETTLE_MS) {
    return "deploy";
  }
  if (lastRunAt === null || now - lastRunAt >= NIGHTLY_MS) return "nightly";
  return null;
}

export async function checkHostReclaim(now = Date.now()): Promise<void> {
  const { getLastHostReclaim, lastDeployAt } = await import("./state");
  const [last, deployAt] = await Promise.all([getLastHostReclaim(), lastDeployAt().catch(() => null)]);
  const startedAt = last ? Date.parse(last.startedAt) : NaN;
  const trigger = dueTrigger({ now, lastRunAt: Number.isFinite(startedAt) ? startedAt : null, lastDeployAt: deployAt });
  if (!trigger) return;
  const { runHostReclaim } = await import("./run");
  const run = await runHostReclaim(trigger, now);
  if (run.skipped) log.info(`Reclaim (${trigger}) skipped: ${run.skipped}`);
}

export const hostReclaimLoop = new IntervalLoop({
  name: "host-reclaim",
  intervalMs: CHECK_INTERVAL_MS,
  firstRunMs: STARTUP_DELAY_MS,
  log,
  run: () => checkHostReclaim(),
});
