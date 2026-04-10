import type { ContainerMetrics } from "./types";

/**
 * Metrics provider interface.
 * Any container metrics source (cAdvisor, Prometheus, etc.) implements this.
 */
export interface MetricsProvider {
  /** Fetch metrics for all Docker containers. */
  fetchAll(): Promise<ContainerMetrics[]>;

  /** Fetch metrics for containers belonging to a specific project. */
  fetchByProject(projectName: string, environmentName?: string): Promise<ContainerMetrics[]>;
}

// ---------------------------------------------------------------------------
// Provider registry — currently only cAdvisor, but pluggable
//
// Uses globalThis so the provider survives across Next.js module instances
// (instrumentation.ts sets it, API routes read it).
// ---------------------------------------------------------------------------

const globalForMetrics = globalThis as unknown as { __vardo_metrics_provider?: MetricsProvider | null };

export function setMetricsProvider(p: MetricsProvider | null) {
  globalForMetrics.__vardo_metrics_provider = p;
}

export function getMetricsProvider(): MetricsProvider | null {
  return globalForMetrics.__vardo_metrics_provider ?? null;
}

/**
 * Convenience: fetch all container metrics from the active provider.
 * Returns empty array if no provider is configured.
 */
export async function fetchAllMetrics(): Promise<ContainerMetrics[]> {
  if (!provider) return [];
  return provider.fetchAll();
}

/**
 * Convenience: fetch project-scoped metrics from the active provider.
 * Returns empty array if no provider is configured.
 */
export async function fetchProjectMetrics(
  projectName: string,
  environmentName?: string,
): Promise<ContainerMetrics[]> {
  if (!provider) return [];
  return provider.fetchByProject(projectName, environmentName);
}
