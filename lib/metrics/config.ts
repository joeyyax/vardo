/**
 * Check if metrics collection and display is enabled.
 * Metrics are always available — loki and cadvisor always run.
 */
export function isMetricsEnabled(): boolean {
  return true;
}
