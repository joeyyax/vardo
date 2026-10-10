import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("image-updates");

/** Paced to stay inside the registry pull budget. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

// Lets the app finish booting before the first registry call.
export const imageUpdateSweepLoop = new IntervalLoop({
  name: "image-update-sweep",
  intervalMs: SWEEP_INTERVAL_MS,
  firstRunMs: STARTUP_DELAY_MS,
  log,
  run: async () => {
    const { refreshStaleChecks } = await import("./check");
    const checked = await refreshStaleChecks();
    if (checked > 0) log.info(`Checked ${checked} image${checked === 1 ? "" : "s"}`);
    const { probeUnknownApps } = await import("./stateful-probe");
    await probeUnknownApps();
  },
});

export const imageUpdatePruneLoop = new IntervalLoop({
  name: "image-update-prune",
  intervalMs: PRUNE_INTERVAL_MS,
  log,
  run: async () => {
    const { pruneExpiredChecks, pruneOrphanedChecks } = await import("./check");
    await pruneExpiredChecks();
    await pruneOrphanedChecks();
  },
});
