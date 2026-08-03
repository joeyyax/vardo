// ---------------------------------------------------------------------------
// Daily reclamation sweep.
//
// The sweep reports what it did to every organization's notification feed.
// A background delete nobody is told about is not acceptable even when correct.
// ---------------------------------------------------------------------------

import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";
import { formatBytes } from "@/lib/metrics/format";

const log = logger.child("image-reclaim");

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 60 * 1000;

let sweepInterval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let sweeping = false;

export async function runScheduledSweep(): Promise<void> {
  const { getImageReclaimConfig } = await import("./settings");
  const config = await getImageReclaimConfig();
  if (!config.enabled) return;

  const { buildReclaimPlan } = await import("./plan");
  const { executeReclaimPlan } = await import("./run");

  const plan = await buildReclaimPlan(config.idleDays);
  if (plan.candidates.length === 0) return;

  const result = await executeReclaimPlan(plan, { dryRun: false });
  const freed = result.reclaimed.filter((r) => r.freedLayers).length;

  const { recordLastRun } = await import("./settings");
  await recordLastRun(result);

  log.info(
    `Sweep removed ${freed} image(s) from ${result.appsAffected} idle app(s), ` +
      `up to ${formatBytes(result.estimatedBytesFreed)}; ${result.failed.length} could not be removed`,
  );
}

async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await runScheduledSweep();
  } catch (err) {
    log.error("Sweep failed:", err);
  } finally {
    sweeping = false;
  }
}

export function startImageReclaim(): void {
  if (sweepInterval) return;
  log.info("Idle image reclamation started (24h sweep)");
  startupTimer = setTimeout(() => void sweep(), STARTUP_DELAY_MS);
  sweepInterval = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
}

export function stopImageReclaim(): void {
  if (startupTimer) clearTimeout(startupTimer);
  if (sweepInterval) clearInterval(sweepInterval);
  startupTimer = null;
  sweepInterval = null;
}

export async function registerImageReclaimPlugin(): Promise<void> {
  if (!isFeatureEnabled("image-updates")) {
    log.info("Image updates disabled, skipping image reclaim registration");
    return;
  }
  startImageReclaim();
}
