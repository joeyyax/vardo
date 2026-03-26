import { sweepStuckDeployments } from "./sweeper";
import { logger } from "@/lib/logger";

const log = logger.child("deploy-sweeper");

let interval: NodeJS.Timeout | null = null;

export function startDeploySweeper(): void {
  if (interval) return; // Already running

  log.info("Deploy sweeper started (60s interval)");
  interval = setInterval(async () => {
    try {
      await sweepStuckDeployments();
    } catch (err) {
      log.error("Sweep error:", err);
    }
  }, 60_000); // Every minute
}

export function stopDeploySweeper(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Deploy sweeper stopped");
  }
}
