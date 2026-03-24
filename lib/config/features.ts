/**
 * Feature flags for Vardo.
 *
 * Controls which features are available system-wide. Useful for:
 * - Simplified UX (disable environments, previews)
 * - Pre-release/testing (gate new features)
 *
 * Resolution: config file (vardo.yml) > DB system_settings > default (true).
 * Core features (projects, apps, deployments) cannot be disabled.
 * Metrics and logs are always available — no opt-out.
 */

export type FeatureFlag =
  | "ui"
  | "terminal"
  | "environments"
  | "backups"
  | "cron"
  | "passwordAuth"
  | "mesh";

type FlagConfig = {
  label: string;
  description: string;
};

const FLAG_CONFIG: Record<FeatureFlag, FlagConfig> = {
  ui: {
    label: "Web UI",
    description: "Web dashboard for managing projects, apps, and deployments",
  },
  terminal: {
    label: "Terminal",
    description: "Web-based shell access to running containers. Disabling removes the Terminal tab from app detail pages.",
  },
  environments: {
    label: "Environments",
    description: "Multiple deployment environments per app (staging, preview). Disabling limits apps to a single production environment.",
  },
  backups: {
    label: "Backups",
    description: "Scheduled volume snapshots to S3-compatible storage. Also required for mesh volume transfers between instances.",
  },
  cron: {
    label: "Cron Jobs",
    description: "Scheduled command execution inside containers. Disabling removes the Cron tab from app detail pages.",
  },
  passwordAuth: {
    label: "Password Auth",
    description:
      "Email/password sign-in and onboarding. When disabled, users must authenticate via passkey, magic link or GitHub.",
  },
  mesh: {
    label: "Instances",
    description:
      "Connect multiple Vardo instances over encrypted WireGuard tunnels. Enables promote, pull and clone between instances.",
  },
};

/**
 * Check if a feature is enabled (synchronous).
 * Reads from cached config file if available, otherwise defaults to true.
 * For the authoritative async check, use isFeatureEnabledAsync().
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  // Synchronous — can only check defaults. Async version is authoritative.
  return true;
}

/**
 * Check if a feature is enabled (async, authoritative).
 * Resolution: config file > DB > default (true).
 */
export async function isFeatureEnabledAsync(flag: FeatureFlag): Promise<boolean> {
  const { getFeatureFlagsConfig } = await import("@/lib/system-settings");
  const flags = await getFeatureFlagsConfig();
  if (flags && flag in flags) return flags[flag];

  return true; // default enabled
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
export type UIGatedFlag = "terminal" | "cron" | "backups";

/**
 * Subset of feature flags relevant to UI tab gating.
 * Passed from server components to client components as a serializable object.
 */
export type FeatureFlags = Record<UIGatedFlag, boolean>;

/**
 * Get the feature flags needed for UI tab gating.
 * Async — reads from config file or DB.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  const [terminal, cron, backups] = await Promise.all([
    isFeatureEnabledAsync("terminal"),
    isFeatureEnabledAsync("cron"),
    isFeatureEnabledAsync("backups"),
  ]);
  return { terminal, cron, backups };
}

export type FeatureFlagInfo = {
  flag: FeatureFlag;
  enabled: boolean;
  label: string;
  description: string;
};

/**
 * Get all feature flags with their states and metadata.
 * Async — reads from config file or DB.
 */
export async function getAllFeatureFlags(): Promise<FeatureFlagInfo[]> {
  return Promise.all(
    (Object.keys(FLAG_CONFIG) as FeatureFlag[]).map(async (flag) => ({
      flag,
      enabled: await isFeatureEnabledAsync(flag),
      label: FLAG_CONFIG[flag].label,
      description: FLAG_CONFIG[flag].description,
    })),
  );
}
