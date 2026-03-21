export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Check encryption key
    const { checkEncryptionKey } = await import("./lib/crypto/encrypt");
    const keyCheck = checkEncryptionKey();
    if (!keyCheck.ok) {
      console.warn(`[instrumentation] ⚠️  ${keyCheck.error}`);
    } else {
      console.log("[instrumentation] Encryption key configured");
    }

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

    console.log("[instrumentation] Starting domain monitor...");
    try {
      setInterval(async () => {
        try {
          const { checkAllDomains } = await import("./lib/domains/monitor");
          await checkAllDomains();
        } catch (err) {
          console.error("[domain-monitor] Error:", err);
        }
      }, 5 * 60 * 1000);
      console.log("[instrumentation] Domain monitor started (every 5 minutes)");
    } catch (err) {
      console.error("[instrumentation] Failed to start domain monitor:", err);
    }
  }
}
