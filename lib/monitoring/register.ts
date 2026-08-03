import { registerInternalHandler } from "@/lib/hooks/registry";
import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("monitoring");

export async function registerMonitoringPlugin(): Promise<void> {
  if (!isFeatureEnabled("monitoring")) {
    log.info("Monitoring disabled, skipping registration");
    return;
  }

  // Kept so an existing hook registration still resolves. The grace period is
  // reconciled by the deploy sweeper from the deployment rows, not from here.
  registerInternalHandler("monitoring:start-rollback-monitor", async () => ({
    allowed: true,
    reason: "Auto-rollback is reconciled by the deploy sweeper",
  }));

  registerInternalHandler("monitoring:drift-check", async (context) => {
    try {
      const { runPostDeployDriftCheck } = await import("@/lib/volumes/drift-check");
      await runPostDeployDriftCheck({
        appId: context.appId as string,
        organizationId: context.organizationId as string,
        appName: context.appName as string,
        log: () => "", // Drift check is non-blocking, logs to its own output
      });
      return { allowed: true, reason: "Drift check completed" };
    } catch (err) {
      return { allowed: true, reason: `Drift check failed: ${err}` };
    }
  });

  // Start system health monitor
  try {
    const { startSystemAlertMonitor } = await import("@/lib/system-alerts/monitor");
    startSystemAlertMonitor();
    log.info("System health monitor started");
  } catch (err) {
    log.error("Failed to start system health monitor:", err);
  }

  // Start container health monitor (auto-restart unhealthy app containers)
  try {
    const { startHealthMonitor } = await import("@/lib/docker/health-monitor");
    startHealthMonitor();
    log.info("Container health monitor started");
  } catch (err) {
    log.error("Failed to start container health monitor:", err);
  }

  // Start app status reconciler (apps.status vs actual container state)
  try {
    const { startStatusReconciler } = await import("@/lib/docker/status-reconcile");
    startStatusReconciler();
    log.info("App status reconciler started");
  } catch (err) {
    log.error("Failed to start app status reconciler:", err);
  }

  // Start Traefik routing drift monitor (stale backend IPs after a daemon restart)
  try {
    const { startTraefikDriftMonitor } = await import("@/lib/docker/traefik-drift");
    startTraefikDriftMonitor();
    log.info("Traefik drift monitor started");
  } catch (err) {
    log.error("Failed to start Traefik drift monitor:", err);
  }

  // Audit stored compose configs for silently-ignored settings
  import("@/lib/docker/compose-audit")
    .then(({ reportStoredComposeConfigs }) => reportStoredComposeConfigs())
    .catch((err) => log.warn("Compose audit failed to start:", err));

  log.info("Monitoring hooks and system health monitor registered");
}
