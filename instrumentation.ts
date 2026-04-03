import { logger } from "./lib/logger";

const log = logger.child("init");

const globalForInit = globalThis as unknown as { __vardo_initialized?: boolean };

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Dedup guard — prevents duplicate schedulers on hot reload
    if (globalForInit.__vardo_initialized) return;
    globalForInit.__vardo_initialized = true;
    // Verify data directories are writable — must run first so deploys don't
    // fail with cryptic EACCES errors later.
    const { ensureDataDirs } = await import("./lib/paths");
    const badDirs = await ensureDataDirs();
    if (badDirs.length > 0) {
      log.error(
        `Data directories not writable: ${badDirs.join(", ")}. ` +
        `Deploys will fail. Fix ownership: chown -R 1001:1001 ${badDirs.join(" ")}`,
      );
    }

    // Load feature flags into sync cache — must run early so isFeatureEnabled()
    // returns real values instead of defaults for the rest of startup
    const { loadFeatureFlags } = await import("./lib/config/features");
    await loadFeatureFlags().catch((err) =>
      log.warn("Failed to load feature flags:", err)
    );

    // Check encryption key — must run first, before any other initialization
    const { checkEncryptionKey } = await import("./lib/crypto/encrypt");
    const keyCheck = checkEncryptionKey();
    if (!keyCheck.ok) {
      log.warn(keyCheck.error!);
    } else {
      log.info("Encryption key configured");
    }

    // Ensure backup target exists first (sequential dependency for scheduler)
    let backupTargetReady: Promise<void> | undefined;
    try {
      const { ensureHostBackupTarget, ensureSystemBackupJob } = await import("./lib/backup/auto-backup");
      const { startBackupScheduler } = await import("./lib/backup/scheduler");
      backupTargetReady = ensureHostBackupTarget()
        .then(async (target) => {
          if (target) {
            log.info(`Vardo backup target ready: ${target.name} (${target.type})`);
            // Create system backup job for Vardo's own database
            await ensureSystemBackupJob(target.id);
          } else {
            log.info("No backup storage configured (add backup section to vardo.yml or configure in admin settings)");
          }
          startBackupScheduler();
          log.info("Backup scheduler started");
        })
        .catch((err) => {
          log.error("Backup setup failed:", err);
        });
    } catch (err) {
      log.error("Failed to import backup modules:", err);
    }

    // Fire all independent startup tasks in parallel
    const tasks: Promise<unknown>[] = [];

    if (backupTargetReady) {
      tasks.push(backupTargetReady);
    }

    tasks.push(
      import("./lib/metrics/config")
        .then(async ({ initMetricsProvider }) => { await initMetricsProvider(); })
        .then(() => import("./lib/metrics/collector"))
        .then(({ startCollector }) => {
          startCollector();
          log.info("Metrics collector started");
        })
        .catch((err) => log.error("Failed to start collector:", err)),

      import("./lib/cron/scheduler")
        .then(({ startCronScheduler }) => {
          startCronScheduler();
          log.info("Cron scheduler started");
        })
        .catch((err) => log.error("Failed to start cron scheduler:", err)),

      import("./lib/notifications/scheduler")
        .then(({ startNotificationRetryScheduler }) => {
          startNotificationRetryScheduler();
          log.info("Notification retry scheduler started");
        })
        .catch((err) => log.error("Failed to start notification retry scheduler:", err)),

      import("./lib/system-alerts/monitor")
        .then(({ startSystemAlertMonitor }) => {
          startSystemAlertMonitor();
          log.info("System health monitor started");
        })
        .catch((err) => log.error("Failed to start system health monitor:", err)),

      import("./lib/digest/scheduler")
        .then(({ startDigestScheduler }) => {
          startDigestScheduler();
          log.info("Digest scheduler started");
        })
        .catch((err) => log.error("Failed to start digest scheduler:", err)),

      import("./lib/deploy/scheduler")
        .then(({ startDeploySweeper }) => {
          startDeploySweeper();
          log.info("Deploy sweeper started");
        })
        .catch((err) => log.error("Failed to start deploy sweeper:", err)),

      import("./lib/mesh/scheduler")
        .then(({ startMeshHeartbeatScheduler }) => {
          startMeshHeartbeatScheduler();
          log.info("Mesh heartbeat scheduler started");
        })
        .catch((err) => log.error("Failed to start mesh heartbeat scheduler:", err)),

      import("./lib/docker/self-register")
        .then(({ ensureVardoProject }) => ensureVardoProject())
        .then(() => log.info("Vardo self-registration complete"))
        .catch((err) => log.warn("Vardo self-registration skipped:", err)),

      Promise.resolve().then(() => {
        const domainLog = logger.child("domain-monitor");
        let ticking = false;
        setInterval(async () => {
          if (ticking) return;
          ticking = true;
          try {
            const { checkAllDomains } = await import("./lib/domains/monitor");
            await checkAllDomains();
          } catch (err) {
            domainLog.error("Error:", err);
          } finally {
            ticking = false;
          }
        }, 5 * 60 * 1000);
        log.info("Domain monitor started (every 5 minutes)");
      }),
    );

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      log.error(`${failed} startup task(s) failed`);
    }
  }
}
