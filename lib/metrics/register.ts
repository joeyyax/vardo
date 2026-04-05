import { logger } from "@/lib/logger";

const log = logger.child("metrics");

export async function registerMetricsPlugin(): Promise<void> {
  try {
    const { startCollector } = await import("@/lib/metrics/collector");
    startCollector();
    log.info("Metrics collector started");
  } catch (err) {
    log.error("Failed to start metrics collector:", err);
  }
}
