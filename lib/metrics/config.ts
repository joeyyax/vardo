import { getMetricsProvider, setMetricsProvider, type MetricsProvider } from "./provider";
import { CadvisorProvider } from "./cadvisor";
import { CollectorMetricsProvider, dockerLabelSource } from "./collector-provider";
import { FallbackMetricsProvider } from "./fallback-provider";
import { CollectorClient } from "@/lib/collector/client";
import { collectorMode, collectorTokenSource } from "@/lib/collector/config";
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
      const cadvisor = customUrl ? new CadvisorProvider(customUrl) : new CadvisorProvider();
      const provider = withCollector(cadvisor);
      log.info(`Metrics provider: ${provider === cadvisor ? (customUrl ? `custom → ${customUrl}` : "default (cadvisor)") : provider.name}`);
      setMetricsProvider(provider);
      return;
    }
  } catch {
    // Feature flag system not ready.
  }
}

/** The collector backed by cAdvisor when VARDO_COLLECTOR_URL or VARDO_COLLECTOR_IMAGE is set, else cAdvisor alone. */
export function withCollector(cadvisor: MetricsProvider, env: Record<string, string | undefined> = process.env): MetricsProvider {
  const mode = collectorMode(env);
  if (mode.kind === "off") return cadvisor;
  const client = new CollectorClient(mode.url, collectorTokenSource(mode, env));
  const collector = new CollectorMetricsProvider(client, {
    dockerLabels: dockerLabelSource(async () => (await import("@/lib/docker/client")).listContainers()),
    disk: {
      enabled: async () => (await (await import("@/lib/infra/cadvisor-config")).getCadvisorConfig()).diskMetricsEnabled,
      provider: cadvisor,
    },
  });
  return new FallbackMetricsProvider(collector, cadvisor);
}
