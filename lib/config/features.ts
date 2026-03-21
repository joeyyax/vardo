/**
 * Feature flags for Host.
 *
 * Controls which features are available system-wide. Useful for:
 * - Resource-constrained deployments (disable metrics, logs)
 * - Simplified UX (disable environments, previews)
 * - Pre-release/testing (gate new features)
 *
 * All flags default to enabled. Set the env var to "false" to disable.
 * Core features (projects, apps, deployments) cannot be disabled.
 */

export type FeatureFlag =
  | "metrics"
  | "logs"
  | "terminal"
  | "environments"
  | "backups"
  | "cron";

const FLAG_ENV_MAP: Record<FeatureFlag, string> = {
  metrics: "FEATURE_METRICS",
  logs: "FEATURE_LOGS",
  terminal: "FEATURE_TERMINAL",
  environments: "FEATURE_ENVIRONMENTS",
  backups: "FEATURE_BACKUPS",
  cron: "FEATURE_CRON",
};

/**
 * Check if a feature is enabled. Defaults to true.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const envVar = FLAG_ENV_MAP[flag];
  return process.env[envVar] !== "false";
}

/**
 * Get all feature flags and their states.
 */
export function getAllFeatureFlags(): Record<FeatureFlag, boolean> {
  const flags = {} as Record<FeatureFlag, boolean>;
  for (const key of Object.keys(FLAG_ENV_MAP) as FeatureFlag[]) {
    flags[key] = isFeatureEnabled(key);
  }
  return flags;
}
