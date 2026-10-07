import { getMetricsProvider, setMetricsProvider } from "./provider";
import { CadvisorProvider } from "./cadvisor";
import { logger } from "@/lib/logger";

const log = logger.child("metrics-config");

/** Whether a metrics provider is configured. */
export function isMetricsEnabled(): boolean {
  return getMetricsProvider() !== null;
}

/** Initializes the metrics provider from integration settings, falling back to CADVISOR_URL. */
export async function initMetricsProvider() {
  if (getMetricsProvider()) return;
  await resolveProvider();
}

/** Re-resolves the provider. Call after connecting or disconnecting a metrics integration. */
export async function reinitMetricsProvider() {
  setMetricsProvider(null);
  await resolveProvider();
}

/** Shared resolution logic for init and reinit. */
async function resolveProvider() {
  try {
    const { isFeatureEnabledAsync } = await import("@/lib/config/features");
    const metricsEnabled = await isFeatureEnabledAsync("metrics");

    if (metricsEnabled) {
      const { getSystemSettingRaw } = await import("@/lib/system-settings");
      const customUrl = await getSystemSettingRaw("metrics.cadvisorUrl");
      log.info(`Metrics provider: ${customUrl ? `custom → ${customUrl}` : "default (cadvisor)"}`);
      setMetricsProvider(customUrl ? new CadvisorProvider(customUrl) : new CadvisorProvider());
      return;
    }
  } catch {
    // Feature flag system not ready.
  }
}
