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
 *
 * Sign-in methods live in lib/config/auth-methods.ts, which still reads the
 * retired passwordAuth key from here as an alias.
 */

export type FeatureFlag =
  | "ui"
  | "environments"
  | "previews"
  | "api-tokens"
  | "mesh"
  | "bindMounts"
  | "dockerSocket"
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
  | "hooks"
  | "image-updates"
  | "teams"
  | "templates"
  | "activity"
  | "away";

/** Section a flag is filed under on the admin Feature flags page. */
export type FlagGroup =
  | "access"
  | "deployment"
  | "observability"
  | "operations"
  | "networking"
  | "advanced";

/** Section order and copy for the admin Feature flags page. */
export const FLAG_GROUPS: { id: FlagGroup; label: string; description: string }[] = [
  { id: "access", label: "Access", description: "How people reach and sign in to this instance." },
  { id: "deployment", label: "Deployment", description: "How apps are promoted, imported and previewed." },
  { id: "observability", label: "Observability", description: "Metrics, logs and health signals." },
  { id: "operations", label: "Operations", description: "Scheduled and background work." },
  { id: "networking", label: "Networking", description: "Certificates and links between instances." },
  { id: "advanced", label: "Advanced", description: "Sharp tools, off by default." },
];

type FlagConfig = {
  label: string;
  description: string;
  defaultValue?: boolean;
  group: FlagGroup;
  /** Settable only from vardo.yml or an env var — never rendered on the admin page. */
  configOnly?: boolean;
  /** Flag this one can't work without. When it's off, this one reads as unavailable. */
  dependsOn?: FeatureFlag;
  /**
   * Turns on a core service shared by the whole instance rather than a per-org
   * capability. One container, one app row, every organization reading it — so
   * the flag governs both provisioning the service and access to it.
   */
  sharedService?: boolean;
};

const FLAG_CONFIG: Record<FeatureFlag, FlagConfig> = {
  ui: {
    label: "Web dashboard",
    description:
      "The web UI for projects, apps and deployments. Disabling leaves the REST API at /api/v1/ as the only way in.",
    group: "access",
    configOnly: true,
  },
  environments: {
    label: "Environments",
    description:
      "Multiple deployment environments per app (staging, preview). Disabling limits apps to a single production environment.",
    group: "deployment",
  },
  previews: {
    label: "PR previews",
    description:
      "Ephemeral preview environments for pull requests, created on PR open and torn down on close. Disabling leaves git deploys working without spinning up per-PR stacks. Previews of Vardo itself also need Self-management.",
    group: "deployment",
  },
  "api-tokens": {
    label: "API tokens",
    description:
      "Bearer token authentication for the REST API and MCP endpoint. Disabling leaves browser sessions as the only way in and hides token management.",
    group: "access",
  },
  mesh: {
    label: "Instances",
    description:
      "Connect multiple Vardo instances over encrypted WireGuard tunnels. Enables promote, pull and clone between instances.",
    group: "networking",
  },
  bindMounts: {
    label: "Bind mounts",
    description:
      "Allow host path mounts in compose definitions. Required for homelab services with local config or NFS mounts. Disabled by default for security on shared instances.",
    defaultValue: false,
    group: "advanced",
  },
  dockerSocket: {
    label: "Docker socket",
    description:
      "Allow mounting /var/run/docker.sock in compose definitions. Needed for Traefik docker-provider sidecars, Dozzle, Watchtower and similar. A sharp tool — grants full control of the host Docker daemon. Disabled by default; the rest of the mount deny-list stays enforced.",
    defaultValue: false,
    group: "advanced",
  },
  selfManagement: {
    label: "Self-management",
    description:
      "Register Vardo as a managed project visible in the dashboard. Enables PR preview deployments against the Vardo repo.",
    defaultValue: false,
    group: "deployment",
  },
  backups: {
    label: "Backups",
    description: "Scheduled backups with S3, B2, SSH and local storage adapters.",
    group: "operations",
  },
  terminal: {
    label: "Terminal",
    description: "Web-based terminal access to running containers.",
    group: "operations",
  },
  cron: {
    label: "Cron jobs",
    description: "Scheduled task execution for apps.",
    group: "operations",
  },
  notifications: {
    label: "Notifications",
    description: "Alert dispatch via email, webhook and Slack.",
    group: "operations",
  },
  ssl: {
    label: "SSL / TLS",
    description: "Automatic TLS certificates via Let's Encrypt. Controls domain, Traefik and external route settings.",
    group: "networking",
  },
  metrics: {
    label: "Metrics",
    description:
      "Container resource metrics via cAdvisor. One cAdvisor scrapes every container on the host and every organization reads it.",
    group: "observability",
    sharedService: true,
  },
  logging: {
    label: "Logging",
    description:
      "Centralized log aggregation via Loki. One Loki and one Promtail ship every container's logs and every organization reads them.",
    group: "observability",
    sharedService: true,
  },
  "git-integration": {
    label: "Git integration",
    description: "GitHub OAuth, deploy keys, webhook auto-deploy and PR preview environments.",
    group: "deployment",
  },
  security: {
    label: "Security scanning",
    description: "Scheduled scans for exposed ports, missing headers and weak TLS.",
    group: "observability",
  },
  mcp: {
    label: "MCP server",
    description: "Model Context Protocol endpoint at /api/mcp, letting AI tools manage apps and deployments.",
    group: "advanced",
    dependsOn: "api-tokens",
  },
  hooks: {
    label: "Lifecycle hooks",
    description:
      "Run registered hooks at deploy and backup checkpoints. Script hooks execute arbitrary commands on the host as the Vardo process — a sharp tool, equivalent to shell access for anyone who can register one. Disabled by default; webhook and internal hooks stop firing too.",
    defaultValue: false,
    group: "advanced",
  },
  "domain-monitoring": {
    label: "Domain monitoring",
    description: "Periodic DNS health checks and certificate expiry warnings for attached domains.",
    group: "observability",
  },
  "container-import": {
    label: "Container import",
    description: "Discover Docker containers already running on the host and adopt them as Vardo apps.",
    group: "deployment",
  },
  "image-updates": {
    label: "Image updates",
    description:
      "Poll registries for newer image tags and surface what is available. Disabling stops the outbound checks; cached results are kept.",
    group: "observability",
  },
  digest: {
    label: "Weekly digest",
    description: "Emailed summary of deployments, failures and alerts from the past week.",
    group: "operations",
  },
  monitoring: {
    label: "Health monitoring",
    description: "Background health checks on apps and platform services, feeding the attention panel.",
    group: "observability",
  },
  teams: {
    label: "Teams",
    description:
      "Team management: the Team page, invitations, roles and the organization switcher. Disabling hides those surfaces — existing members keep their access and can still sign in.",
    group: "access",
  },
  templates: {
    label: "Templates",
    description: "Starter templates for new apps, offered as a starting point on the New app page.",
    group: "deployment",
  },
  activity: {
    label: "Activity log",
    description:
      "Record of who did what, shown at /activity. Disabling stops the writes as well as hiding the page.",
    group: "observability",
  },
  away: {
    label: "While you were away",
    description: "Per-user summary of what changed since your last visit, surfaced in the attention bar.",
    group: "observability",
  },
};

// ---------------------------------------------------------------------------
// Env var overrides
//
// Every flag maps to VARDO_FEATURE_<NAME>, where <NAME> is the flag name
// upper-snake-cased: hyphens become underscores and camelCase word boundaries
// gain one. So error-tracking -> VARDO_FEATURE_ERROR_TRACKING and
// bindMounts -> VARDO_FEATURE_BIND_MOUNTS.
// ---------------------------------------------------------------------------

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSY = new Set(["0", "false", "no", "off", "disabled"]);

/** Env var name that pins a flag, e.g. "error-tracking" -> VARDO_FEATURE_ERROR_TRACKING. */
export function featureFlagEnvVar(flag: FeatureFlag): string {
  const name = flag
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toUpperCase();
  return `VARDO_FEATURE_${name}`;
}

/** Flag value from the environment, or undefined when unset or unparseable. */
export function featureFlagFromEnv(flag: FeatureFlag): boolean | undefined {
  const raw = process.env[featureFlagEnvVar(flag)];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return undefined;
}

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
 * Reads the env var, then the in-memory cache populated by loadFeatureFlags().
 * If the cache hasn't loaded yet (early startup), falls back to the default.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const fromEnv = featureFlagFromEnv(flag);
  if (fromEnv !== undefined) return fromEnv;
  if (flagCache && flag in flagCache) return flagCache[flag];
  return FLAG_CONFIG[flag]?.defaultValue ?? true;
}

/**
 * Check if a feature is enabled (async, authoritative).
 * Resolution: env var > vardo.yml > DB > default.
 * Also refreshes the sync cache as a side effect.
 */
export async function isFeatureEnabledAsync(flag: FeatureFlag): Promise<boolean> {
  const fromEnv = featureFlagFromEnv(flag);
  if (fromEnv !== undefined) return fromEnv;

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
export type FeatureFlags = Record<
  "terminal" | "cron" | "backups" | "metrics" | "logging" | "environments" | "imageUpdates",
  boolean
>;

/**
 * Get feature flags needed for UI tab gating.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  const [terminal, cron, backups, metrics, logging, environments, imageUpdates] = await Promise.all([
    isFeatureEnabledAsync("terminal"),
    isFeatureEnabledAsync("cron"),
    isFeatureEnabledAsync("backups"),
    isFeatureEnabledAsync("metrics"),
    isFeatureEnabledAsync("logging"),
    isFeatureEnabledAsync("environments"),
    isFeatureEnabledAsync("image-updates"),
  ]);
  return { terminal, cron, backups, metrics, logging, environments, imageUpdates };
}

/** Every declared flag, in declaration order. */
export const ALL_FEATURE_FLAGS = Object.keys(FLAG_CONFIG) as FeatureFlag[];

/** Which layer decided a flag's current value. */
export type FlagSource = "env" | "config" | "database" | "default";

export type FeatureFlagInfo = {
  flag: FeatureFlag;
  enabled: boolean;
  label: string;
  description: string;
  group: FlagGroup;
  source: FlagSource;
  /** True when an env var or vardo.yml pins the value and the admin page can't change it. */
  locked: boolean;
  /** Env var name that pins this flag, shown alongside a locked toggle. */
  envVar: string;
  /** True when the flag this one depends on is off, so turning it on changes nothing. */
  unavailable: boolean;
  /** The dependency and its label, for explaining an unavailable flag. */
  dependsOn?: { flag: FeatureFlag; label: string };
  /** True when this flag turns on a core service shared by every organization. */
  sharedService: boolean;
};

/** Flags whose service is a single instance-wide install, not a per-org one. */
export const SHARED_SERVICE_FLAGS = (Object.entries(FLAG_CONFIG) as [FeatureFlag, FlagConfig][])
  .filter(([, config]) => config.sharedService)
  .map(([flag]) => flag);

/** Resolve a flag's value and the layer it came from. */
export function resolveFeatureFlag(
  flag: FeatureFlag,
  layers: { config: Record<string, boolean>; database: Record<string, boolean> },
): { enabled: boolean; source: FlagSource } {
  const fromEnv = featureFlagFromEnv(flag);
  if (fromEnv !== undefined) return { enabled: fromEnv, source: "env" };
  if (flag in layers.config) return { enabled: layers.config[flag], source: "config" };
  if (flag in layers.database) return { enabled: layers.database[flag], source: "database" };
  return { enabled: FLAG_CONFIG[flag]?.defaultValue ?? true, source: "default" };
}

/**
 * Every admin-settable flag with its state, source and metadata.
 * Config-only flags (the dashboard kill switch) are left out.
 */
export async function getAllFeatureFlags(): Promise<FeatureFlagInfo[]> {
  const { getFeatureFlagLayers } = await import("@/lib/system-settings");
  const layers = await getFeatureFlagLayers();

  const entries = (Object.entries(FLAG_CONFIG) as [FeatureFlag, FlagConfig][])
    .filter(([, config]) => !config.configOnly);

  return entries.map(([flag, config]) => {
    const { enabled, source } = resolveFeatureFlag(flag, layers);
    const dependency = config.dependsOn;
    return {
      flag,
      enabled,
      label: config.label,
      description: config.description,
      group: config.group,
      source,
      locked: source === "env" || source === "config",
      envVar: featureFlagEnvVar(flag),
      unavailable: dependency ? !resolveFeatureFlag(dependency, layers).enabled : false,
      dependsOn: dependency ? { flag: dependency, label: FLAG_CONFIG[dependency].label } : undefined,
      sharedService: config.sharedService ?? false,
    };
  });
}
