import { tickNotificationRetries } from "./retry";

let interval: NodeJS.Timeout | null = null;

export function startNotificationRetryScheduler(): void {
  if (interval) return;

  console.log("[notifications] Retry scheduler started (30s interval)");
  interval = setInterval(async () => {
    try {
      await tickNotificationRetries();
    } catch (err) {
      console.error("[notifications] Retry tick error:", err);
    }
  }, 30_000);
}
