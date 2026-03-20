export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("[instrumentation] Starting metrics collector...");
    try {
      const { startCollector } = await import("./lib/metrics/collector");
      startCollector();
      console.log("[instrumentation] Metrics collector started");
    } catch (err) {
      console.error("[instrumentation] Failed to start collector:", err);
    }

    console.log("[instrumentation] Starting cron scheduler...");
    try {
      const { startCronScheduler } = await import("./lib/cron/scheduler");
      startCronScheduler();
      console.log("[instrumentation] Cron scheduler started");
    } catch (err) {
      console.error("[instrumentation] Failed to start cron scheduler:", err);
    }
  }
}
