export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Check encryption key — must run first, before any other initialization
    const { checkEncryptionKey } = await import("./lib/crypto/encrypt");
    const keyCheck = checkEncryptionKey();
    if (!keyCheck.ok) {
      console.warn(`[instrumentation] ⚠️  ${keyCheck.error}`);
    } else {
      console.log("[instrumentation] Encryption key configured");
    }

    // Ensure backup target exists first (sequential dependency for scheduler)
    let backupTargetReady: Promise<void> | undefined;
    try {
      const { ensureHostBackupTarget } = await import("./lib/backup/auto-backup");
      const { startBackupScheduler } = await import("./lib/backup/scheduler");
      backupTargetReady = ensureHostBackupTarget()
        .then((target) => {
          if (target) {
            console.log(`[instrumentation] Host backup target ready: ${target.name} (${target.type})`);
          } else {
            console.log("[instrumentation] No backup storage configured (set BACKUP_STORAGE_* env vars or configure in settings)");
          }
          startBackupScheduler();
          console.log("[instrumentation] Backup scheduler started");
        })
        .catch((err) => {
          console.error("[instrumentation] Backup setup failed:", err);
        });
    } catch (err) {
      console.error("[instrumentation] Failed to import backup modules:", err);
    }

    // Fire all independent startup tasks in parallel
    const tasks: Promise<unknown>[] = [];

    if (backupTargetReady) {
      tasks.push(backupTargetReady);
    }

    tasks.push(
      import("./lib/metrics/collector")
        .then(({ startCollector }) => {
          startCollector();
          console.log("[instrumentation] Metrics collector started");
        })
        .catch((err) => console.error("[instrumentation] Failed to start collector:", err)),

      import("./lib/cron/scheduler")
        .then(({ startCronScheduler }) => {
          startCronScheduler();
          console.log("[instrumentation] Cron scheduler started");
        })
        .catch((err) => console.error("[instrumentation] Failed to start cron scheduler:", err)),

      import("./lib/notifications/scheduler")
        .then(({ startNotificationRetryScheduler }) => {
          startNotificationRetryScheduler();
          console.log("[instrumentation] Notification retry scheduler started");
        })
        .catch((err) => console.error("[instrumentation] Failed to start notification retry scheduler:", err)),

      import("./lib/system-alerts/monitor")
        .then(({ startSystemAlertMonitor }) => {
          startSystemAlertMonitor();
          console.log("[instrumentation] System health monitor started");
        })
        .catch((err) => console.error("[instrumentation] Failed to start system health monitor:", err)),

      import("./lib/digest/scheduler")
        .then(({ startDigestScheduler }) => {
          startDigestScheduler();
          console.log("[instrumentation] Digest scheduler started");
        })
        .catch((err) => console.error("[instrumentation] Failed to start digest scheduler:", err)),

      Promise.resolve().then(() => {
        let ticking = false;
        setInterval(async () => {
          if (ticking) return;
          ticking = true;
          try {
            const { checkAllDomains } = await import("./lib/domains/monitor");
            await checkAllDomains();
          } catch (err) {
            console.error("[domain-monitor] Error:", err);
          } finally {
            ticking = false;
          }
        }, 5 * 60 * 1000);
        console.log("[instrumentation] Domain monitor started (every 5 minutes)");
      }),
    );

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.error(`[instrumentation] ${failed} startup task(s) failed`);
    }
  }
}
