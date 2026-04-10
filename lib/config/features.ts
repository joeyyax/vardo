/**
 * Feature flags for Vardo.
 *
 * Controls which features are available system-wide. Useful for:
 * - Simplified UX (disable environments, previews)
 * - Pre-release/testing (gate new features)
 * - Toggling optional subsystems (backups, terminal, cron, etc.)
 *
 * Resolution: config file (vardo.yml) > DB system_settings > default (true).
 * Core features (projects, apps, deployments) cannot be disabled.
 */

export type FeatureFlag =
  | "ui"
  | "environments"
  | "passwordAuth"
  | "mesh"
  | "bindMounts"
  | "selfManagement"
  | "backups"
  | "terminal"
  | "cron"
  | "notifications"
  | "ssl"
  | "metrics"
  | "logging"
  | "git-integration"
  | "security"
  | "mcp"
  | "domain-monitoring"
  | "container-import"
  | "digest"
  | "monitoring"
  | "error-tracking";

type FlagConfig = {
  label: string;
  description: string;
  defaultValue?: boolean;
  /** If true, this flag appears in the admin Feature Flags settings page. */
  showInUI?: boolean;
};

const FLAG_CONFIG: Record<FeatureFlag, FlagConfig> = {
  ui: {
    label: "Web UI",
    description: "Web dashboard for managing projects, apps, and deployments",
  },
  environments: {
    label: "Environments",
    description: "Multiple deployment environments per app (staging, preview). Disabling limits apps to a single production environment.",
    showInUI: true,
  },
  passwordAuth: {
    label: "Password Auth",
    description:
      "Email/password sign-in and onboarding. When disabled, users must authenticate via passkey, magic link or GitHub.",
    showInUI: true,
  },
  mesh: {
    label: "Instances",
    description:
      "Connect multiple Vardo instances over encrypted WireGuard tunnels. Enables promote, pull and clone between instances.",
    showInUI: true,
  },
  bindMounts: {
    label: "Bind Mounts",
    description:
      "Allow host path mounts in compose definitions. Required for homelab services with local config or NFS mounts. Disabled by default for security on shared instances.",
    defaultValue: false,
    showInUI: true,
  },
  selfManagement: {
    label: "Self-Management",
    description:
      "Register Vardo as a managed project visible in the dashboard. Enables PR preview deployments against the Vardo repo.",
    defaultValue: false,
    showInUI: true,
  },
  backups: {
    label: "Backups",
    description: "Scheduled backups with S3, B2, SSH, and local storage adapters.",
    showInUI: true,
  },
  terminal: {
    label: "Terminal",
    description: "Web-based terminal access to running containers.",
    showInUI: true,
  },
  cron: {
    label: "Cron Jobs",
    description: "Scheduled task execution for apps.",
    showInUI: true,
  },
  notifications: {
    label: "Notifications",
    description: "Alert dispatch via email, webhook, and Slack.",
    showInUI: true,
  },
  ssl: {
    label: "SSL / TLS",
    description: "Automatic TLS certificates via Let's Encrypt. Controls domain, Traefik, and external route settings.",
    showInUI: true,
  },
  metrics: {
    label: "Metrics",
    description: "Container resource metrics via cAdvisor.",
    showInUI: true,
  },
  logging: {
    label: "Logging",
    description: "Centralized log aggregation via Loki.",
    showInUI: true,
  },
  "git-integration": {
    label: "Git Integration",
    description: "GitHub OAuth, deploy keys, webhook auto-deploy, and PR preview environments.",
  },
  security: {
    label: "Security Scanning",
    description: "Automated security scanning for exposed ports, headers, and TLS.",
  },
  mcp: {
    label: "MCP Server",
    description: "Model Context Protocol server for AI tool access.",
  },
  "domain-monitoring": {
    label: "Domain Monitoring",
    description: "Periodic DNS health checks and SSL certificate expiration monitoring.",
  },
  "container-import": {
    label: "Container Import",
    description: "Discover and import running Docker containers into Vardo.",
  },
  digest: {
    label: "Digest",
    description: "Weekly email digest summarizing deployment activity.",
  },
  monitoring: {
    label: "Monitoring",
    description: "System health monitoring and alerting.",
  },
  "error-tracking": {
    label: "Error Tracking",
    description: "Automatic error tracking via GlitchTip (Sentry-compatible).",
    showInUI: true,
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
 * Clear the sync flag cache and reload from the DB.
 * Call after writing feature flags.
 */
export async function invalidateFlagCache(): Promise<void> {
  flagCache = null;
  await loadFeatureFlags().catch(() => {
    // Best-effort reload — sync callers will use defaults until next async call
  });
}

/**
 * Check if a feature is enabled (synchronous).
 * Reads from the in-memory cache populated by loadFeatureFlags().
 * If cache hasn't loaded yet (early startup), defaults to true.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  if (flagCache && flag in flagCache) return flagCache[flag];
  return FLAG_CONFIG[flag]?.defaultValue ?? true;
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
  return FLAG_CONFIG[flag]?.defaultValue ?? true;
}

/**
 * Get the flag config metadata (label, description) for a flag.
 */
export function getFlagConfig(flag: FeatureFlag): FlagConfig {
  return FLAG_CONFIG[flag];
}

/**
 * Subset of feature flags relevant to UI tab gating in app detail views.
 * Passed from server components to client components as a serializable object.
 */
export type FeatureFlags = Record<"terminal" | "cron" | "backups" | "errorTracking", boolean>;

/**
 * Get feature flags needed for UI tab gating.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  const [terminal, cron, backups, errorTracking] = await Promise.all([
    isFeatureEnabledAsync("terminal"),
    isFeatureEnabledAsync("cron"),
    isFeatureEnabledAsync("backups"),
    isFeatureEnabledAsync("error-tracking"),
  ]);
  return { terminal, cron, backups, errorTracking };
}

export type FeatureFlagInfo = {
  flag: FeatureFlag;
  enabled: boolean;
  label: string;
  description: string;
};

/**
 * Get all feature flags with their states and metadata.
 * Only returns flags marked with showInUI for the admin settings page.
 */
export async function getAllFeatureFlags(): Promise<FeatureFlagInfo[]> {
  const uiFlags = (Object.entries(FLAG_CONFIG) as [FeatureFlag, FlagConfig][])
    .filter(([, config]) => config.showInUI);

  return Promise.all(
    uiFlags.map(async ([flag, config]) => ({
      flag,
      enabled: await isFeatureEnabledAsync(flag),
      label: config.label,
      description: config.description,
    })),
  );
}
