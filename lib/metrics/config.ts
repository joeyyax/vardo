import { getMetricsProvider, setMetricsProvider } from "./provider";
import { CadvisorProvider } from "./cadvisor";
import { logger } from "@/lib/logger";

const log = logger.child("metrics-config");

/**
 * Check if metrics collection and display is enabled.
 * Requires a metrics provider to be configured.
 */
export function isMetricsEnabled(): boolean {
  return getMetricsProvider() !== null;
}

/**
 * Initialize the metrics provider from integration settings.
 * Falls back to cAdvisor at CADVISOR_URL if no integration is configured
 * (backwards-compatible with existing installs).
 */
export async function initMetricsProvider() {
  if (getMetricsProvider()) return;
  await resolveProvider();
}

/**
 * Re-resolve the metrics provider from integration settings.
 * Call after connecting or disconnecting a metrics integration.
 */
export async function reinitMetricsProvider() {
  setMetricsProvider(null);
  await resolveProvider();
}

/** Shared resolution logic for init and reinit. */
async function resolveProvider() {
  try {
    const { getIntegration, resolveIntegrationUrl } = await import("@/lib/integrations");
    const integration = await getIntegration("metrics");

    if (integration && integration.status === "connected") {
      const url = await resolveIntegrationUrl("metrics");
      if (url) {
        log.info(`Metrics provider: integration → ${url}`);
        setMetricsProvider(new CadvisorProvider(url));
        return;
      }
    }
  } catch {
    // DB not ready — fall through
  }

  setMetricsProvider(new CadvisorProvider());
  log.info("Metrics provider: default cAdvisor");
}
