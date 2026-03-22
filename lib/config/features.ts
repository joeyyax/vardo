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
  | "ui"
  | "metrics"
  | "logs"
  | "terminal"
  | "environments"
  | "backups"
  | "cron"
  | "passwordAuth";

type FlagConfig = {
  env: string;
  label: string;
  description: string;
};

const FLAG_CONFIG: Record<FeatureFlag, FlagConfig> = {
  ui: {
    env: "FEATURE_UI",
    label: "Web UI",
    description: "Web dashboard for managing projects, apps, and deployments",
  },
  metrics: {
    env: "FEATURE_METRICS",
    label: "Metrics",
    description: "Container CPU, memory, and network monitoring with historical charts",
  },
  logs: {
    env: "FEATURE_LOGS",
    label: "Logs",
    description: "Persistent log collection and streaming via Loki",
  },
  terminal: {
    env: "FEATURE_TERMINAL",
    label: "Terminal",
    description: "Web-based terminal access to running containers",
  },
  environments: {
    env: "FEATURE_ENVIRONMENTS",
    label: "Environments",
    description: "Multiple deployment environments per app (staging, preview)",
  },
  backups: {
    env: "FEATURE_BACKUPS",
    label: "Backups",
    description: "Scheduled volume backups with S3-compatible storage",
  },
  cron: {
    env: "FEATURE_CRON",
    label: "Cron Jobs",
    description: "Scheduled command execution inside containers",
  },
  passwordAuth: {
    env: "FEATURE_PASSWORD_AUTH",
    label: "Password Auth",
    description:
      "Email/password authentication for sign-in and onboarding",
  },
};

/**
 * Check if a feature is enabled (synchronous, env-var only). Defaults to true.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return process.env[FLAG_CONFIG[flag].env] !== "false";
}

/**
 * Check if a feature is enabled with DB fallback.
 * Resolution: env var > DB override > default (true).
 */
export async function isFeatureEnabledAsync(flag: FeatureFlag): Promise<boolean> {
  const envVal = process.env[FLAG_CONFIG[flag].env];
  if (envVal !== undefined) return envVal !== "false";

  const { getFeatureFlagsConfig } = await import("@/lib/system-settings");
  const dbFlags = await getFeatureFlagsConfig();
  if (dbFlags && flag in dbFlags) return dbFlags[flag];

  return true; // default enabled
}

/**
 * Whether a flag's value is forced by an environment variable.
 */
export function isEnvOverridden(flag: FeatureFlag): boolean {
  return process.env[FLAG_CONFIG[flag].env] !== undefined;
}

/**
 * Get the flag config metadata (label, description) for a flag.
 */
export function getFlagConfig(flag: FeatureFlag): FlagConfig {
  return FLAG_CONFIG[flag];
}

/**
 * Feature flags that gate UI tabs and their corresponding API endpoints.
 */
export type UIGatedFlag = "metrics" | "logs" | "terminal" | "cron" | "backups";

/**
 * Subset of feature flags relevant to UI tab gating.
 * Passed from server components to client components as a serializable object.
 */
export type FeatureFlags = Record<UIGatedFlag, boolean>;

/**
 * Get the feature flags needed for UI tab gating.
 * Call this in server components and pass the result as a prop.
 */
export function getFeatureFlags(): FeatureFlags {
  return {
    metrics: isFeatureEnabled("metrics"),
    logs: isFeatureEnabled("logs"),
    terminal: isFeatureEnabled("terminal"),
    cron: isFeatureEnabled("cron"),
    backups: isFeatureEnabled("backups"),
  };
}

export type FeatureFlagInfo = {
  flag: FeatureFlag;
  enabled: boolean;
  label: string;
  description: string;
};

/**
 * Get all feature flags with their states and metadata.
 */
export function getAllFeatureFlags(): FeatureFlagInfo[] {
  return (Object.keys(FLAG_CONFIG) as FeatureFlag[]).map((flag) => ({
    flag,
    enabled: isFeatureEnabled(flag),
    label: FLAG_CONFIG[flag].label,
    description: FLAG_CONFIG[flag].description,
  }));
}
