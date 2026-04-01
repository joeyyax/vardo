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
  | "mesh"
  | "bindMounts"
  | "selfManagement";

type FlagConfig = {
  label: string;
  description: string;
  defaultValue?: boolean;
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
  bindMounts: {
    label: "Bind Mounts",
    description:
      "Allow host path mounts in compose definitions. Required for homelab services with local config or NFS mounts. Disabled by default for security on shared instances.",
    defaultValue: false,
  },
  selfManagement: {
    label: "Self-Management",
    description:
      "Register Vardo as a managed project visible in the dashboard. Enables PR preview deployments against the Vardo repo.",
    defaultValue: false,
  },
};

// ---------------------------------------------------------------------------
// Sync cache — populated by loadFeatureFlags() at startup and refreshed
// by every isFeatureEnabledAsync() call. Sync callers read from this.
// ---------------------------------------------------------------------------

let flagCache: Record<string, boolean> | null = null;

/**
 * Populate the sync flag cache. Call once at startup (instrumentation.ts).
 * After this, isFeatureEnabled() returns real values instead of defaults.
 */
export async function loadFeatureFlags(): Promise<void> {
  const { getFeatureFlagsConfig } = await import("@/lib/system-settings");
  flagCache = (await getFeatureFlagsConfig()) ?? {};
}

/**
 * Check if a feature is enabled (synchronous).
 * Reads from the in-memory cache populated by loadFeatureFlags().
 * If cache hasn't loaded yet (early startup), defaults to true.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  if (flagCache && flag in flagCache) return flagCache[flag];
  return FLAG_CONFIG[flag].defaultValue ?? true;
}

/**
 * Check if a feature is enabled (async, authoritative).
 * Resolution: config file > DB > default (true).
 * Also refreshes the sync cache as a side effect.
 */
export async function isFeatureEnabledAsync(flag: FeatureFlag): Promise<boolean> {
  const { getFeatureFlagsConfig } = await import("@/lib/system-settings");
  const flags = await getFeatureFlagsConfig();

  // Merge into sync cache (don't replace — preserve flags not in this result)
  if (flags) flagCache = { ...flagCache, ...flags };

  if (flags && flag in flags) return flags[flag];
  return FLAG_CONFIG[flag].defaultValue ?? true;
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

/**
 * Flags exposed in the admin settings UI.
 * Excludes "ui" — that's a hard kill switch, not a user-facing toggle.
 */
export const ADMIN_FLAGS: FeatureFlag[] = (
  Object.keys(FLAG_CONFIG) as FeatureFlag[]
).filter((f) => f !== "ui");

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
