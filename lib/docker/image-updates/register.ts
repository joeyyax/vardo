import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("image-updates");

/** Slow enough that a full 82-image fleet still lands well inside the pull budget. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

let sweepInterval: NodeJS.Timeout | null = null;
let pruneInterval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

async function sweep() {
  try {
    const { refreshStaleChecks } = await import("./check");
    const checked = await refreshStaleChecks();
    if (checked > 0) log.info(`Checked ${checked} image${checked === 1 ? "" : "s"}`);
  } catch (err) {
    log.error("Sweep failed:", err);
  }
}

export function startImageUpdateChecks(): void {
  if (sweepInterval) return;

  log.info("Image update checks started (15m sweep)");
  // Let the app finish booting before the first registry call.
  startupTimer = setTimeout(sweep, STARTUP_DELAY_MS);
  sweepInterval = setInterval(sweep, SWEEP_INTERVAL_MS);

  pruneInterval = setInterval(async () => {
    try {
      const { pruneExpiredChecks, pruneOrphanedChecks } = await import("./check");
      await pruneExpiredChecks();
      await pruneOrphanedChecks();
    } catch (err) {
      log.error("Prune failed:", err);
    }
  }, PRUNE_INTERVAL_MS);
}

export async function registerImageUpdatesPlugin(): Promise<void> {
  if (!isFeatureEnabled("image-updates")) {
    log.info("Image updates disabled, skipping registration");
    return;
  }
  startImageUpdateChecks();
}

export function stopImageUpdateChecks(): void {
  if (startupTimer) clearTimeout(startupTimer);
  if (sweepInterval) clearInterval(sweepInterval);
  if (pruneInterval) clearInterval(pruneInterval);
  startupTimer = null;
  sweepInterval = null;
  pruneInterval = null;
}
