import { matchAppMetrics, type MetricsApp } from "./app-match";
import type { ContainerMetrics } from "./types";

/** A container metrics source. */
export interface MetricsProvider {
  /** Shown in logs. */
  readonly name?: string;
  /** How often the source has new data. Unset means DEFAULT_POLL_INTERVAL_MS. */
  readonly pollIntervalMs?: number;
  /** Fetch metrics for all Docker containers. */
  fetchAll(): Promise<ContainerMetrics[]>;
}

/** cAdvisor's live poll cadence. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

// Provider registry on globalThis: instrumentation.ts sets it, API routes read it.

const globalForMetrics = globalThis as unknown as { __vardo_metrics_provider?: MetricsProvider | null };

export function setMetricsProvider(p: MetricsProvider | null) {
  globalForMetrics.__vardo_metrics_provider = p;
}

export function getMetricsProvider(): MetricsProvider | null {
  return globalForMetrics.__vardo_metrics_provider ?? null;
}

/** The active provider's poll cadence. */
export function metricsPollIntervalMs(): number {
  return getMetricsProvider()?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
