import { matchAppMetrics, type MetricsApp } from "./app-match";
import type { ContainerMetrics } from "./types";

/** A container metrics source. */
export interface MetricsProvider {
  /** Fetch metrics for all Docker containers. */
  fetchAll(): Promise<ContainerMetrics[]>;
}

// Provider registry on globalThis: instrumentation.ts sets it, API routes read it.

const globalForMetrics = globalThis as unknown as { __vardo_metrics_provider?: MetricsProvider | null };

export function setMetricsProvider(p: MetricsProvider | null) {
  globalForMetrics.__vardo_metrics_provider = p;
}

export function getMetricsProvider(): MetricsProvider | null {
  return globalForMetrics.__vardo_metrics_provider ?? null;
}

/** All container metrics from the active provider. Empty when none is configured. */
export async function fetchAllMetrics(): Promise<ContainerMetrics[]> {
  const p = getMetricsProvider();
  if (!p) return [];
  return p.fetchAll();
}

/** One app's metrics from the active provider. Empty when none is configured. */
export async function fetchAppMetrics(app: MetricsApp): Promise<ContainerMetrics[]> {
  return matchAppMetrics(app, await fetchAllMetrics());
}
