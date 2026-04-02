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
// ---------------------------------------------------------------------------

let provider: MetricsProvider | null = null;

export function setMetricsProvider(p: MetricsProvider | null) {
  provider = p;
}

export function getMetricsProvider(): MetricsProvider | null {
  return provider;
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
