import { tickBackupJobs } from "./tick";

let interval: NodeJS.Timeout | null = null;

export function startBackupScheduler(): void {
  if (interval) return; // Already running

  console.log("[backup] Scheduler started (60s interval)");
  interval = setInterval(async () => {
    try {
      await tickBackupJobs();
    } catch (err) {
      console.error("[backup] Tick error:", err);
    }
  }, 60_000); // Every minute
}

export function stopBackupScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log("[backup] Scheduler stopped");
  }
}
