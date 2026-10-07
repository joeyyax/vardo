import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("monitoring");

export async function registerMonitoringPlugin(): Promise<void> {
  if (!isFeatureEnabled("monitoring")) {
    log.info("Monitoring disabled, skipping registration");
    return;
  }

  try {
    const { startSystemAlertMonitor } = await import("@/lib/system-alerts/monitor");
    startSystemAlertMonitor();
    log.info("System health monitor started");
  } catch (err) {
    log.error("Failed to start system health monitor:", err);
  }

  // Auto-restarts unhealthy app containers.
  try {
    const { startHealthMonitor } = await import("@/lib/docker/health-monitor");
    startHealthMonitor();
    log.info("Container health monitor started");
  } catch (err) {
    log.error("Failed to start container health monitor:", err);
  }

  // Reconciles apps.status with container state.
  try {
    const { startStatusReconciler } = await import("@/lib/docker/status-reconcile");
    startStatusReconciler();
    log.info("App status reconciler started");
  } catch (err) {
    log.error("Failed to start app status reconciler:", err);
  }

  // Catches stale Traefik backend IPs after a daemon restart.
  try {
    const { startTraefikDriftMonitor } = await import("@/lib/docker/traefik-drift");
    startTraefikDriftMonitor();
    log.info("Traefik drift monitor started");
  } catch (err) {
    log.error("Failed to start Traefik drift monitor:", err);
  }

  // Audits stored compose configs for silently ignored settings.
  import("@/lib/docker/compose-audit")
    .then(({ reportStoredComposeConfigs }) => reportStoredComposeConfigs())
    .catch((err) => log.warn("Compose audit failed to start:", err));

  log.info("Monitoring started");
}
