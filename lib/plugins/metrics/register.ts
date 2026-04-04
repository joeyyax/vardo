// ---------------------------------------------------------------------------
// Metrics plugin registration
//
// Registers the metrics plugin and starts the cAdvisor collector.
// ---------------------------------------------------------------------------

import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:metrics");

export async function registerMetricsPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Metrics plugin registered");

  // Start the collector (non-blocking)
  try {
    const { startCollector } = await import("@/lib/metrics/collector");
    startCollector();
    log.info("Metrics collector started");
  } catch (err) {
    log.error("Failed to start metrics collector:", err);
  }
}
