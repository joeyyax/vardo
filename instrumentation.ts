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
      const { ensureHostBackupTarget, ensureSystemBackupJob } = await import("./lib/backups/auto-backup");
      const { startBackupScheduler } = await import("./lib/backups/scheduler");
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

    // Register feature subsystems — hooks, consumers, schedulers, monitors.
    // Each register function handles its own startup initialization.
    const features: [string, () => Promise<void>][] = [
      ["notifications", async () => { const m = await import("./lib/notifications/register"); await m.registerNotificationsPlugin(); }],
      ["metrics", async () => { const m = await import("./lib/metrics/register"); await m.registerMetricsPlugin(); }],
      ["backups", async () => { const m = await import("./lib/backups/register"); await m.registerBackupsPlugin(); }],
      ["security", async () => { const m = await import("./lib/security/register"); await m.registerSecurityPlugin(); }],
      ["monitoring", async () => { const m = await import("./lib/monitoring/register"); await m.registerMonitoringPlugin(); }],
      ["ssl", async () => { const m = await import("./lib/ssl/register"); await m.registerSslPlugin(); }],
      ["cron", async () => { const m = await import("./lib/cron/register"); await m.registerCronPlugin(); }],
      ["domain-monitoring", async () => { const m = await import("./lib/domain-monitoring/register"); await m.registerDomainMonitoringPlugin(); }],
      ["digest", async () => { const m = await import("./lib/digest/register"); await m.registerDigestPlugin(); }],
    ];

    for (const [label, register] of features) {
      try {
        await register();
      } catch (err) {
        log.error(`Failed to register ${label}:`, err);
      }
    }

    // Core startup tasks — not plugins, fundamental to the platform
    const tasks: Promise<unknown>[] = [];

    if (backupTargetReady) {
      tasks.push(backupTargetReady);
    }

    tasks.push(
      // Deploy sweeper — cleans up stuck queued deployments
      import("./lib/deploy/scheduler")
        .then(({ startDeploySweeper }) => {
          startDeploySweeper();
          log.info("Deploy sweeper started");
        })
        .catch((err) => log.error("Failed to start deploy sweeper:", err)),

      // Mesh heartbeat — core networking, not a plugin
      import("./lib/mesh/scheduler")
        .then(({ startMeshHeartbeatScheduler }) => {
          startMeshHeartbeatScheduler();
          log.info("Mesh heartbeat scheduler started");
        })
        .catch((err) => log.error("Failed to start mesh heartbeat scheduler:", err)),

      // Self-registration — Vardo managing itself, core feature
      import("./lib/docker/self-register")
        .then(({ ensureVardoProject }) => ensureVardoProject())
        .then(() => log.info("Vardo self-registration complete"))
        .catch((err) => log.warn("Vardo self-registration skipped:", err)),
    );

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      log.error(`${failed} startup task(s) failed`);
    }
  }
}
