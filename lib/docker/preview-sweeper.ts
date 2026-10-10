import { cleanupExpiredPreviews } from "./preview";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("preview-sweeper");

/** Previews outlive their expiry by at most this long. */
const SWEEP_INTERVAL_MS = 15 * 60_000;

// Sweeps at start too.
export const previewSweepLoop = new IntervalLoop({
  name: "preview-sweep",
  intervalMs: SWEEP_INTERVAL_MS,
  firstRunMs: 0,
  log,
  run: async () => {
    const cleaned = await cleanupExpiredPreviews();
    if (cleaned > 0) log.info(`Destroyed ${cleaned} expired preview(s)`);
  },
});
