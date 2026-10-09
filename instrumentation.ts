import { logger } from "./lib/logger";

const log = logger.child("init");

const globalForInit = globalThis as unknown as { __vardo_initialized?: boolean };

export async function register() {
  // Instrumentation also loads in the Edge runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Prevents duplicate schedulers on hot reload.
    if (globalForInit.__vardo_initialized) return;
    globalForInit.__vardo_initialized = true;

    // Registered first so a SIGTERM during startup is still handled.
    const { installShutdownHandlers } = await import("./lib/shutdown");
    installShutdownHandlers();

    // Verifies data directories are writable.
    const { ensureDataDirs } = await import("./lib/paths");
    const badDirs = await ensureDataDirs();
    if (badDirs.length > 0) {
      log.error(
        `Data directories not writable: ${badDirs.join(", ")}. ` +
        `Deploys will fail. Fix ownership: chown -R 1001:1001 ${badDirs.join(" ")}`,
      );
    }

    // Traefik serves its API only through this router.
    const { writeTraefikApiConfig } = await import("./lib/docker/traefik-api-access");
    await writeTraefikApiConfig().catch((err) => log.warn("Failed to write the Traefik API router:", err));

    // Defines cloudflare-only@file for domains and the console lock.
    const { startCloudflareOnlySync } = await import("./lib/docker/cloudflare-only");
    startCloudflareOnlySync();

    // Must run early so isFeatureEnabled() returns real values for the rest of startup.
    const { loadFeatureFlags } = await import("./lib/config/features");
    await loadFeatureFlags().catch((err) =>
      log.warn("Failed to load feature flags:", err)
    );

    // buildAuth() reads sign-in methods synchronously.
    const { loadAuthMethods } = await import("./lib/config/auth-methods");
    await loadAuthMethods().catch((err) =>
      log.warn("Failed to load sign-in methods:", err)
    );
    const { refreshSetupState } = await import("./lib/auth");
    await refreshSetupState().catch((err) =>
      log.warn("Failed to read setup state:", err)
    );

    const { checkEncryptionKey } = await import("./lib/crypto/encrypt");
    const keyCheck = checkEncryptionKey();
    if (!keyCheck.ok) {
      log.warn(keyCheck.error!);
    } else {
      log.info("Encryption key configured");
    }

    // Whether the running key is the one this database's ciphertext belongs to.
    const { checkKeyEscrowAtStartup } = await import("./lib/crypto/key-escrow");
    const escrow = await checkKeyEscrowAtStartup();

    // Encrypts legacy plaintext credentials. Must run before the backup scheduler.
    try {
      const { canEncryptStoredCredentials, encryptStoredCredentials } = await import(
        "./lib/crypto/encrypt-stored-credentials"
      );
      if (canEncryptStoredCredentials(escrow)) {
        await encryptStoredCredentials();
      } else if (keyCheck.ok) {
        log.warn("Left stored credentials unencrypted — the running key isn't confirmed for this database");
      }
    } catch (err) {
      log.error("Credential encryption failed:", err);
    }

    // Encrypts legacy OAuth tokens with Better Auth's secret, not the master key.
    try {
      const { auth } = await import("./lib/auth");
      const { encryptStoredOAuthTokens } = await import("./lib/auth/oauth-tokens");
      await encryptStoredOAuthTokens((await auth.$context).secretConfig);
    } catch (err) {
      log.error("OAuth token encryption failed:", err);
    }

    // Writes an encrypted marker, so it runs after the key check.
    try {
      const { retireGlitchTip } = await import("./lib/infra/retire-glitchtip");
      await retireGlitchTip();
    } catch (err) {
      log.error("GlitchTip retirement failed:", err);
    }

    // Re-encrypts secrets stranded by app transfers.
    if (keyCheck.ok) {
      try {
        const { repairTransferredSecrets } = await import("./lib/transfers/engine");
        const repaired = await repairTransferredSecrets();
        if (repaired > 0) log.info(`Repaired ${repaired} secret(s) and deploy key(s) stranded by earlier app transfers`);
      } catch (err) {
        log.error("Transfer secret repair failed:", err);
      }
    }

    // Moves backups recorded under an app's pre-transfer org.
    try {
      const { realignBackupOrgs } = await import("./lib/backups/org-backup");
      const moved = await realignBackupOrgs();
      if (moved > 0) log.info(`Moved ${moved} backup(s) to their app's current org`);
    } catch (err) {
      log.error("Backup org realignment failed:", err);
    }

    // Repairs backup job links left in a transferred app's source org.
    try {
      const { repairForeignJobLinks } = await import("./lib/backups/transfer");
      const repaired = await repairForeignJobLinks();
      log.info(`Repaired ${repaired} backup job link(s) left in another org by earlier app transfers`);
    } catch (err) {
      log.error("Backup job link repair failed:", err);
    }

    // The backup scheduler waits on the target.
    let backupTargetReady: Promise<void> | undefined;
    try {
      const { ensureHostBackupTarget, ensureSystemBackupJob } = await import("./lib/backups/auto-backup");
      const { startBackupScheduler } = await import("./lib/backups/scheduler");
      backupTargetReady = ensureHostBackupTarget()
        .then(async (target) => {
          if (target) {
            log.info(`Vardo backup target ready: ${target.name} (${target.type})`);
            await ensureSystemBackupJob(target.id);
          } else {
            log.info("No backup storage configured (add backup section to vardo.yml or configure in admin settings)");
          }
          startBackupScheduler();
          log.info("Backup scheduler started");
          // Enroll apps the backup switch has on and stop the ones it has off.
          const { reconcileInBackground } = await import("./lib/backups/switch");
          reconcileInBackground({});
        })
        .catch((err) => {
          log.error("Backup setup failed:", err);
        });
    } catch (err) {
      log.error("Failed to import backup modules:", err);
    }

    // Provisions cAdvisor, Loki and Promtail before feature registration so collectors find them.
    try {
      const { ensureInfraServices } = await import("./lib/infra/provision");
      await ensureInfraServices();
    } catch (err) {
      log.error("Infrastructure provisioning failed:", err);
    }

    // Each register function checks its own feature flag.
    const features: [string, () => Promise<void>][] = [
      ["notifications", async () => { const m = await import("./lib/notifications/register"); await m.registerNotificationsPlugin(); }],
      ["metrics", async () => { const m = await import("./lib/metrics/register"); await m.registerMetricsPlugin(); }],
      ["monitoring", async () => { const m = await import("./lib/monitoring/register"); await m.registerMonitoringPlugin(); }],
      ["cron", async () => { const m = await import("./lib/cron/register"); await m.registerCronPlugin(); }],
      ["domain-monitoring", async () => { const m = await import("./lib/domain-monitoring/register"); await m.registerDomainMonitoringPlugin(); }],
      ["domain-verification", async () => { const m = await import("./lib/domains/register"); await m.registerDomainVerificationPlugin(); }],
      ["digest", async () => { const m = await import("./lib/digest/register"); await m.registerDigestPlugin(); }],
      ["logging", async () => { const m = await import("./lib/logging/register"); await m.registerLoggingFeature(); }],
      ["image-updates", async () => { const m = await import("./lib/docker/image-updates/register"); await m.registerImageUpdatesPlugin(); }],
      ["image-reclaim", async () => { const m = await import("./lib/docker/image-reclaim/register"); await m.registerImageReclaimPlugin(); }],
    ];

    for (const [label, register] of features) {
      try {
        await register();
      } catch (err) {
        log.error(`Failed to register ${label}:`, err);
      }
    }

    // Core startup tasks.
    const tasks: Promise<unknown>[] = [];

    if (backupTargetReady) {
      tasks.push(backupTargetReady);
    }

    tasks.push(
      // Cleans up stuck queued deployments.
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

      // Nothing else removes expired preview environments.
      import("./lib/config/features")
        .then(({ isFeatureEnabledAsync }) => isFeatureEnabledAsync("previews"))
        .then(async (enabled) => {
          if (!enabled) return;
          const { startPreviewSweeper } = await import("./lib/docker/preview-sweeper");
          startPreviewSweeper();
          log.info("Preview sweeper started");
        })
        .catch((err) => log.error("Failed to start preview sweeper:", err)),

      // Picks up a whole-instance restore a restart interrupted.
      import("./lib/restore/database")
        .then(({ resumeInstanceRestore }) => resumeInstanceRestore())
        .catch((err) => log.error("Instance restore resume failed:", err)),

      import("./lib/docker/self-register")
        .then(({ ensureVardoProject }) => ensureVardoProject())
        .then(() => log.info("Vardo self-registration complete"))
        .catch((err) => log.warn("Vardo self-registration skipped:", err)),

      // Stamps app directory owners while top-level app names are still globally unique.
      import("./lib/docker/app-dir-owner")
        .then(({ stampAppDirOwnersAtStartup }) => stampAppDirOwnersAtStartup())
        .catch((err) => log.warn("App directory ownership pass skipped:", err)),
    );

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      log.error(`${failed} startup task(s) failed`);
    }
  }
}
