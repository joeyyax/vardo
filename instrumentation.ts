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

    // Fails startup on a DOCKER_HOST the API client can't use.
    const { getConnectionOptions } = await import("./lib/docker/client");
    getConnectionOptions();

    // Verifies data directories are writable.
    const { ensureDataDirs } = await import("./lib/paths");
    const badDirs = await ensureDataDirs();
    if (badDirs.length > 0) {
      log.error(
        `Data directories not writable: ${badDirs.join(", ")}. ` +
        `Deploys will fail. Fix ownership: chown -R 1001:1001 ${badDirs.join(" ")}`,
      );
    }

    // Before the first request: off vardo-network once Traefik reaches the console on vardo_console.
    const { isolateConsoleSafely } = await import("./lib/docker/console-network");
    await isolateConsoleSafely();

    // Traefik serves its API only through this router.
    const { writeTraefikApiConfig } = await import("./lib/docker/traefik-api-access");
    await writeTraefikApiConfig().catch((err) => log.warn("Failed to write the Traefik API router:", err));

    // Defines cloudflare-only@file for domains and the console lock. The cloudflare-only-sync loop refreshes it.
    const { syncCloudflareOnly } = await import("./lib/docker/cloudflare-only");
    await syncCloudflareOnly().catch((err) => log.warn("Failed to write the Cloudflare middleware:", err));
    const { syncConsolePublicRoute } = await import("./lib/docker/console-lock");
    await syncConsolePublicRoute().catch((err) => log.warn("Failed to write the console's public route:", err));
    const { writeReachRoute } = await import("./lib/docker/reach-route");
    await writeReachRoute().catch((err) => log.warn("Failed to write the domain check route:", err));
    // Routers reference each app's headers middleware by name; Traefik disables a router whose middleware is missing.
    const { syncAllHeadersFiles } = await import("./lib/docker/headers-sync");
    await syncAllHeadersFiles().catch((err) => log.warn("Failed to write security headers files:", err));
    // Probe guard routers. The probe-guard loop keeps them current.
    const { syncGuardFile } = await import("./lib/probe-guard/sync");
    await syncGuardFile().catch((err) => log.warn("Failed to write the probe guard file:", err));
    const { regenerateExternalRoutesConfig } = await import("./lib/ssl/generate-external-routes-config");
    await regenerateExternalRoutesConfig().catch((err) => log.warn("Failed to write external routes:", err));

    // Sizes tier defaults and deploy concurrency. Kept in memory, so a resized host picks up new defaults on restart.
    const { detectHost } = await import("./lib/resources/host");
    await detectHost();

    // Must run early so isFeatureEnabled() returns real values for the rest of startup.
    const { loadFeatureFlags } = await import("./lib/config/features");
    await loadFeatureFlags().catch((err) =>
      log.warn("Failed to load feature flags:", err)
    );

    // Live metrics streams read the collector from this process even when the worker runs the metrics loop.
    const { initMetricsProvider } = await import("./lib/metrics/config");
    await initMetricsProvider().catch((err) => log.warn("Failed to set up the metrics provider:", err));

    // Auto-domains follow the instance base domain over VARDO_BASE_DOMAIN.
    try {
      const { getInstanceConfig } = await import("./lib/system-settings");
      const { baseDomainMismatch } = await import("./lib/domain-monitoring/auto-domain");
      const mismatch = baseDomainMismatch((await getInstanceConfig()).baseDomain);
      if (mismatch) log.warn(mismatch);
    } catch (err) {
      log.warn("Failed to compare base domains:", err);
    }

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

    // Encrypts legacy plaintext credentials. Must run before the backup scheduler, here and in the worker.
    let credentialStep: "encrypted" | "skipped" | "failed" = "skipped";
    try {
      const { canEncryptStoredCredentials, encryptStoredCredentials } = await import(
        "./lib/crypto/encrypt-stored-credentials"
      );
      if (canEncryptStoredCredentials(escrow)) {
        await encryptStoredCredentials();
        credentialStep = "encrypted";
      } else if (keyCheck.ok) {
        log.warn("Left stored credentials unencrypted — the running key isn't confirmed for this database");
      }
    } catch (err) {
      log.error("Credential encryption failed:", err);
      credentialStep = "failed";
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

    // Fails backups a stopped process left running. Skipped whole when Redis can't vouch for leases.
    try {
      const { reapInterruptedBackups, sweepOrphanedStaging } = await import("./lib/backups/reap");
      // Spares rows younger than a minute: a worker's new run takes its lease just after the insert.
      await reapInterruptedBackups(new Date(), { minAgeMs: 60_000 });
      await sweepOrphanedStaging();
    } catch (err) {
      log.error("Interrupted backup cleanup failed:", err);
    }

    // Tells the watchdog and install.sh this console has backup work a restart would cut off.
    try {
      const { startBackupWorkBeacon } = await import("./lib/backups/in-flight");
      startBackupWorkBeacon();
    } catch (err) {
      log.error("Backup work beacon failed to start:", err);
    }

    // The backup loops wait on the target.
    let backupTargetReady: Promise<void> | undefined;
    try {
      const { ensureHostBackupTarget, ensureSystemBackupJob } = await import("./lib/backups/auto-backup");
      backupTargetReady = ensureHostBackupTarget()
        .then(async (target) => {
          if (target) {
            log.info(`Vardo backup target ready: ${target.name} (${target.type})`);
            await ensureSystemBackupJob(target.id);
          } else {
            log.info("No backup storage configured (add backup section to vardo.yml or configure in admin settings)");
          }
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

    // The worker's backup loops wait for this record.
    void (backupTargetReady ?? Promise.resolve())
      .then(() => import("./lib/backups/boot-gate"))
      .then(({ recordBackupBootInBackground }) => recordBackupBootInBackground(credentialStep))
      .catch((err) => log.error("Failed to record backup boot steps:", err));

    // Provisions the collector, Loki and Promtail before feature registration so their readers find them.
    try {
      const { ensureInfraServices } = await import("./lib/infra/provision");
      await ensureInfraServices();
    } catch (err) {
      log.error("Infrastructure provisioning failed:", err);
    }

    // Each register function checks its own feature flag.
    const features: [string, () => Promise<void>][] = [
      ["notifications", async () => { const m = await import("./lib/notifications/register"); await m.registerNotificationsPlugin(); }],
      ["monitoring", async () => { const m = await import("./lib/monitoring/register"); await m.registerMonitoringPlugin(); }],
      ["logging", async () => { const m = await import("./lib/logging/register"); await m.registerLoggingFeature(); }],
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
      // Every background loop, from lib/worker/registry.ts. Instance-wide ones go to a present worker (VARDO_LOOPS_IN_WEB).
      import("./lib/worker/handoff")
        .then(({ startWebLoops }) => startWebLoops({ "backup-target": backupTargetReady }))
        .catch((err) => log.error("Failed to start background loops:", err)),

      // Picks up a whole-instance restore a restart interrupted.
      import("./lib/restore/database")
        .then(({ resumeInstanceRestore }) => resumeInstanceRestore())
        .catch((err) => log.error("Instance restore resume failed:", err)),

      import("./lib/docker/self-register")
        .then(({ ensureVardoProject }) => ensureVardoProject())
        .then(() => log.info("Vardo self-registration complete"))
        .catch((err) => log.warn("Vardo self-registration skipped:", err)),

      // Lists compose-label domains for apps last deployed before deploys recorded them.
      import("./lib/domains/compose-domains")
        .then(({ reconcileComposeDomains }) => reconcileComposeDomains())
        .then(({ synced }) => { if (synced > 0) log.info(`Compose domains listed for ${synced} app(s)`); })
        .catch((err) => log.warn("Compose domain reconcile skipped:", err)),

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
