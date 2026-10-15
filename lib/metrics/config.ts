import { getMetricsProvider, setMetricsProvider, type MetricsProvider } from "./provider";
import { CollectorMetricsProvider, dockerLabelSource, WritableLayerSizes } from "./collector-provider";
import { CollectorClient } from "@/lib/collector/client";
import { collectorMode, collectorTokenSource, type CollectorMode } from "@/lib/collector/config";
import { logger } from "@/lib/logger";

const log = logger.child("metrics-config");

type Env = Record<string, string | undefined>;

/** `VARDO_COLLECTOR_IMAGE=off`: no container metrics, while the loop keeps disk usage and business metrics. */
export const NO_CONTAINER_METRICS: MetricsProvider = {
  name: "none (VARDO_COLLECTOR_IMAGE=off)",
  fetchAll: async () => [],
};

/** Whether container metrics are read. False with the feature off or in off mode. */
export function isMetricsEnabled(): boolean {
  const provider = getMetricsProvider();
  return provider !== null && provider !== NO_CONTAINER_METRICS;
}

/** Whether the metrics loop runs: the feature is on, with or without container metrics. */
export function isMetricsLoopEnabled(): boolean {
  return getMetricsProvider() !== null;
}

/** Initializes the metrics provider when the metrics feature is on. */
export async function initMetricsProvider() {
  if (getMetricsProvider()) return;
  await resolveProvider();
}

/** Re-resolves the provider. Call after the metrics feature is toggled. */
export async function reinitMetricsProvider() {
  setMetricsProvider(null);
  await resolveProvider();
}

async function resolveProvider() {
  try {
    const { isFeatureEnabledAsync } = await import("@/lib/config/features");
    if (!(await isFeatureEnabledAsync("metrics"))) return;
    const provider = metricsProvider();
    log.info(`Metrics provider: ${provider.name}`);
    setMetricsProvider(provider);
  } catch {
    // Feature flag system not ready.
  }
}

/** The collector, or no container metrics in off mode. */
export function metricsProvider(env: Env = process.env): MetricsProvider {
  const mode = collectorMode(env);
  if (mode.kind === "off") return NO_CONTAINER_METRICS;
  return collectorProvider(mode, env, {
    onFirstServe: () => {
      import("@/lib/collector/served")
        .then(({ markCollectorServed }) => markCollectorServed())
        .catch((err) => log.warn("Couldn't record the collector's first read:", err));
    },
  });
}

/** A fresh provider for this collector, sharing nothing with the registered one. */
export function collectorProvider(
  mode: Exclude<CollectorMode, { kind: "off" }>,
  env: Env = process.env,
  opts: { onFirstServe?: () => void } = {},
): CollectorMetricsProvider {
  const client = new CollectorClient(mode.url, collectorTokenSource(mode, env));
  const docker = async () => (await import("@/lib/docker/client")).dockerRequest;
  return new CollectorMetricsProvider(client, {
    dockerLabels: dockerLabelSource(async (id) => {
      const res = await (await docker())<{ Config?: { Labels?: Record<string, string> | null } }>("GET", `/containers/${encodeURIComponent(id)}/json`);
      return res.Config?.Labels ?? {};
    }),
    // Docker measures the sizes. Collector 0.3.0 measures them itself.
    sizes: new WritableLayerSizes(
      async (id) => {
        const res = await (await docker())<{ SizeRw?: number }>("GET", `/containers/${encodeURIComponent(id)}/json?size=1`, undefined, { timeoutMs: 30_000 });
        return typeof res.SizeRw === "number" ? res.SizeRw : null;
      },
      async () => (await import("./disk-setting")).getDiskMetricsEnabled(),
    ),
    onFirstServe: opts.onFirstServe,
  });
}
