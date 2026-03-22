import { tickCronJobs } from "./engine";

let interval: NodeJS.Timeout | null = null;

export function startCronScheduler(): void {
  if (interval) return; // Already running

  console.log("[cron] Scheduler started (60s interval)");
  interval = setInterval(async () => {
    try {
      await tickCronJobs();
    } catch (err) {
      console.error("[cron] Tick error:", err);
    }
  }, 60_000); // Every minute
}

export function stopCronScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log("[cron] Scheduler stopped");
  }
}
