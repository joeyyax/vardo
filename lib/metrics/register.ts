import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";

const log = logger.child("metrics");

export async function registerMetricsPlugin(): Promise<void> {
  if (!isFeatureEnabled("metrics")) {
    log.info("Metrics disabled, skipping registration");
    return;
  }

  try {
    const { startCollector } = await import("@/lib/metrics/collector");
    startCollector();
    log.info("Metrics collector started");
  } catch (err) {
    log.error("Failed to start metrics collector:", err);
  }
}
