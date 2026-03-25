import { tickDigestJobs } from "./tick";
import { logger } from "@/lib/logger";

const log = logger.child("digest");

let interval: NodeJS.Timeout | null = null;
let ticking = false;

export function startDigestScheduler(): void {
  if (interval) return; // Already running

  log.info("Scheduler started (60s interval)");
  interval = setInterval(async () => {
    if (ticking) {
      log.info("Previous tick still running, skipping");
      return;
    }
    ticking = true;
    try {
      await tickDigestJobs();
    } catch (err) {
      log.error("Tick error:", err);
    } finally {
      ticking = false;
    }
  }, 60_000); // Every minute
}

export function stopDigestScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Scheduler stopped");
  }
}
