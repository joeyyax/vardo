import { registerInternalHandler } from "@/lib/hooks/registry";
import { logger } from "@/lib/logger";

const log = logger.child("monitoring");

export async function registerMonitoringPlugin(): Promise<void> {
  registerInternalHandler("monitoring:start-rollback-monitor", async (context) => {
    try {
      const { startRollbackMonitor } = await import("@/lib/docker/rollback-monitor");
      const app = context.app as Record<string, unknown>;
      if (!app.autoRollback || !context.activeSlot || context.isLocalEnv) {
        return { allowed: true, reason: "Rollback monitor not applicable" };
      }
      startRollbackMonitor({
        appId: context.appId as string,
        appName: app.name as string,
        organizationId: context.organizationId as string,
        deploymentId: context.deploymentId as string,
        gracePeriodSeconds: (app.rollbackGracePeriod as number) ?? 60,
        currentSlot: context.newSlot as "blue" | "green",
        previousSlot: context.activeSlot as "blue" | "green",
        envName: context.envName as string,
      });
      return { allowed: true, reason: "Rollback monitor started" };
    } catch (err) {
      return { allowed: true, reason: `Rollback monitor failed: ${err}` };
    }
  });

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

  log.info("Monitoring hooks and system health monitor registered");
}
