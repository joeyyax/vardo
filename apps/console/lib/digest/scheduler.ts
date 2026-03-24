import { tickDigestJobs } from "./tick";

let interval: NodeJS.Timeout | null = null;
let ticking = false;

export function startDigestScheduler(): void {
  if (interval) return; // Already running

  console.log("[digest] Scheduler started (60s interval)");
  interval = setInterval(async () => {
    if (ticking) {
      console.log("[digest] Previous tick still running, skipping");
      return;
    }
    ticking = true;
    try {
      await tickDigestJobs();
    } catch (err) {
      console.error("[digest] Tick error:", err);
    } finally {
      ticking = false;
    }
  }, 60_000); // Every minute
}

export function stopDigestScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log("[digest] Scheduler stopped");
  }
}
