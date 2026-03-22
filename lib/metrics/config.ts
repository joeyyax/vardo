import { isFeatureEnabled } from "@/lib/config/features";

/**
 * Check if metrics collection and display is enabled.
 */
export function isMetricsEnabled(): boolean {
  return isFeatureEnabled("metrics");
}
