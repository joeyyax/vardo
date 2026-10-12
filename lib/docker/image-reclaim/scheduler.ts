// Daily reclamation sweep.

import { IntervalLoop } from "@/lib/worker/interval-loop";
import { logger } from "@/lib/logger";
import { formatBytes } from "@/lib/metrics/format";

const log = logger.child("image-reclaim");

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 60 * 1000;

export async function runScheduledSweep(): Promise<void> {
  const { getImageReclaimConfig } = await import("./settings");
  const config = await getImageReclaimConfig();
  if (!config.enabled) return;

  const { buildReclaimPlan } = await import("./plan");
  const { executeReclaimPlan } = await import("./run");

  const plan = await buildReclaimPlan(config.idleDays);
  if (plan.candidates.length > 0) {
    const result = await executeReclaimPlan(plan, { dryRun: false });
    const freed = result.reclaimed.filter((r) => r.freedLayers).length;

    const { recordLastRun } = await import("./settings");
    await recordLastRun(result);

    log.info(
      `Sweep removed ${freed} image(s) from ${result.appsAffected} idle app(s), ` +
        `up to ${formatBytes(result.estimatedBytesFreed)}; ${result.failed.length} could not be removed`,
    );
  }

  if (!config.slots) return;

  const { buildSlotReclaimPlan, withoutRollbackTargets } = await import("./slot-plan");
  const fullPlan = await buildSlotReclaimPlan();
  // Scheduled cleanup keeps rollback targets.
  const slotPlan = withoutRollbackTargets(fullPlan);
  if (slotPlan.candidates.length === 0) return;

  const slotResult = await executeReclaimPlan(slotPlan, { dryRun: false });
  const slotFreed = slotResult.reclaimed.filter((r) => r.freedLayers).length;

  log.info(
    `Sweep removed ${slotFreed} image(s) from ${slotPlan.candidates.length} superseded slot ` +
      `generation(s), up to ${formatBytes(slotResult.estimatedBytesFreed)}; ` +
      `${slotResult.failed.length} could not be removed`,
  );
}

export const imageReclaimLoop = new IntervalLoop({
  name: "image-reclaim",
  intervalMs: SWEEP_INTERVAL_MS,
  firstRunMs: STARTUP_DELAY_MS,
  log,
  run: () => runScheduledSweep(),
});
