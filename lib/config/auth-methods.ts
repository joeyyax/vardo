/**
 * Sign-in methods for Vardo.
 *
 * Each method switches independently and is enforced in lib/auth/index.ts, so
 * a disabled method can't authenticate rather than merely being hidden.
 * At least one method must stay usable — see assertMethodsRemain().
 *
 * Resolution: env var > vardo.yml (auth.methods) > DB (auth_methods) > default.
 * `password` also reads the retired passwordAuth feature flag at every layer.
 */

export type AuthMethod = "password" | "passkey" | "magic-link" | "totp" | "github";

/** Configuration a method can't work without. */
export type AuthPrerequisite = "email" | "github-app";

type MethodConfig = {
  label: string;
  description: string;
  defaultValue?: boolean;
  /** Must be configured before the method can be used. */
  requires?: AuthPrerequisite;
  /** Retired feature flag key, still read as a fallback at every layer. */
  legacyFlag?: string;
};

const METHOD_CONFIG: Record<AuthMethod, MethodConfig> = {
  password: {
    label: "Password",
    description:
      "Email and password sign-in, plus password changes and resets. Onboarding the first user always uses it, whatever this says.",
    legacyFlag: "passwordAuth",
  },
  passkey: {
    label: "Passkey",
    description: "WebAuthn passkeys — Touch ID, Windows Hello and hardware security keys.",
  },
  "magic-link": {
    label: "Magic link",
    description: "One-time sign-in links sent by email, valid for 10 minutes.",
    requires: "email",
  },
  totp: {
    label: "Authenticator app",
    description:
      "Time-based codes from an authenticator app, used as a second factor after sign-in. Turning it off stops enrolment and skips the prompt for accounts that already have it.",
  },
  github: {
    label: "GitHub OAuth",
    description: "Sign in with a GitHub account. Existing accounts on a matching email are linked.",
    requires: "github-app",
  },
};

/** Every declared method, in declaration order. */
export const ALL_AUTH_METHODS = Object.keys(METHOD_CONFIG) as AuthMethod[];

/** Prerequisite copy, phrased for the admin page. */
const PREREQUISITE_REASON: Record<AuthPrerequisite, string> = {
  email: "Needs email, which isn't configured. Set a provider up first.",
  "github-app": "Needs a GitHub app, which isn't configured. Set one up first.",
};

// ---------------------------------------------------------------------------
// Env var overrides
//
// Every method maps to VARDO_AUTH_<NAME>, where <NAME> is the method name
// upper-snake-cased. So magic-link -> VARDO_AUTH_MAGIC_LINK.
// ---------------------------------------------------------------------------

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSY = new Set(["0", "false", "no", "off", "disabled"]);

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return undefined;
}

/** Env var name that pins a method, e.g. "magic-link" -> VARDO_AUTH_MAGIC_LINK. */
export function authMethodEnvVar(method: AuthMethod): string {
  return `VARDO_AUTH_${method.replace(/-/g, "_").toUpperCase()}`;
}

/** Retired feature flag env var that still pins a method, if it has one. */
function legacyEnvVar(method: AuthMethod): string | undefined {
  const flag = METHOD_CONFIG[method].legacyFlag;
  if (!flag) return undefined;
  const name = flag
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toUpperCase();
  return `VARDO_FEATURE_${name}`;
}

/** Method value from the environment, or undefined when unset or unparseable. */
export function authMethodFromEnv(method: AuthMethod): boolean | undefined {
  const own = parseBool(process.env[authMethodEnvVar(method)]);
  if (own !== undefined) return own;
  const legacy = legacyEnvVar(method);
  return legacy ? parseBool(process.env[legacy]) : undefined;
}

// ---------------------------------------------------------------------------
// Layers and resolution
// ---------------------------------------------------------------------------

export type AuthMethodLayers = {
  /** vardo.yml auth.methods */
  config: Record<string, boolean>;
  /** system_settings auth_methods */
  database: Record<string, boolean>;
  /** vardo.yml features — read for retired flag keys only */
  legacyConfig: Record<string, boolean>;
  /** system_settings feature_flags — read for retired flag keys only */
  legacyDatabase: Record<string, boolean>;
};

/** Which layer decided a method's current value. */
export type AuthMethodSource = "env" | "config" | "database" | "default";

/** Read every layer a method can be set in. */
export async function getAuthMethodLayers(): Promise<AuthMethodLayers> {
  const { getAuthMethodConfigLayers, getFeatureFlagLayers } = await import("@/lib/system-settings");
  const [own, flags] = await Promise.all([getAuthMethodConfigLayers(), getFeatureFlagLayers()]);
  return {
    config: own.config,
    database: own.database,
    legacyConfig: flags.config,
    legacyDatabase: flags.database,
  };
}

/** Resolve a method's value and the layer it came from. */
export function resolveAuthMethod(
  method: AuthMethod,
  layers: AuthMethodLayers,
): { enabled: boolean; source: AuthMethodSource; envVar: string } {
  const config = METHOD_CONFIG[method];
  const legacy = config.legacyFlag;

  const ownEnv = parseBool(process.env[authMethodEnvVar(method)]);
  if (ownEnv !== undefined) return { enabled: ownEnv, source: "env", envVar: authMethodEnvVar(method) };

  const legacyName = legacyEnvVar(method);
  const legacyEnv = legacyName ? parseBool(process.env[legacyName]) : undefined;
  if (legacyEnv !== undefined) return { enabled: legacyEnv, source: "env", envVar: legacyName! };

  const envVar = authMethodEnvVar(method);
  if (method in layers.config) return { enabled: layers.config[method], source: "config", envVar };
  if (legacy && legacy in layers.legacyConfig) {
    return { enabled: layers.legacyConfig[legacy], source: "config", envVar };
  }
  if (method in layers.database) return { enabled: layers.database[method], source: "database", envVar };
  if (legacy && legacy in layers.legacyDatabase) {
    return { enabled: layers.legacyDatabase[legacy], source: "database", envVar };
  }
  return { enabled: config.defaultValue ?? true, source: "default", envVar };
}

// ---------------------------------------------------------------------------
// Sync cache — populated by loadAuthMethods() at startup and refreshed by
// every isAuthMethodEnabledAsync() call. buildAuth() reads from this.
// ---------------------------------------------------------------------------

let methodCache: Record<string, boolean> | null = null;

/** Populate the sync method cache. Call once at startup (instrumentation.ts). */
export async function loadAuthMethods(): Promise<void> {
  const layers = await getAuthMethodLayers();
  methodCache = Object.fromEntries(
    ALL_AUTH_METHODS.map((method) => [method, resolveAuthMethod(method, layers).enabled]),
  );
}

/** Clear the sync method cache and reload it. Call after writing methods. */
export async function invalidateAuthMethodCache(): Promise<void> {
  methodCache = null;
  await loadAuthMethods().catch(() => {
    // Best-effort reload — sync callers use defaults until the next async call
  });
}

/**
 * Whether a sign-in method is enabled (synchronous).
 * Falls back to the default until loadAuthMethods() has run.
 */
export function isAuthMethodEnabled(method: AuthMethod): boolean {
  const fromEnv = authMethodFromEnv(method);
  if (fromEnv !== undefined) return fromEnv;
  if (methodCache && method in methodCache) return methodCache[method];
  return METHOD_CONFIG[method].defaultValue ?? true;
}

/** Whether a sign-in method is enabled (async, authoritative). */
export async function isAuthMethodEnabledAsync(method: AuthMethod): Promise<boolean> {
  const fromEnv = authMethodFromEnv(method);
  if (fromEnv !== undefined) return fromEnv;

  const layers = await getAuthMethodLayers();
  const { enabled } = resolveAuthMethod(method, layers);
  methodCache = { ...methodCache, [method]: enabled };
  return enabled;
}

/** Every method's enabled state, for passing to client components. */
export async function getAuthMethodStates(): Promise<Record<AuthMethod, boolean>> {
  const layers = await getAuthMethodLayers();
  const states = Object.fromEntries(
    ALL_AUTH_METHODS.map((method) => [method, resolveAuthMethod(method, layers).enabled]),
  ) as Record<AuthMethod, boolean>;
  methodCache = { ...methodCache, ...states };
  return states;
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

/** Which prerequisites are satisfied on this instance. */
export async function checkPrerequisites(): Promise<Record<AuthPrerequisite, boolean>> {
  const { getGitHubAppConfig, getEmailProviderConfig } = await import("@/lib/system-settings");
  const [github, email] = await Promise.all([
    getGitHubAppConfig().catch(() => null),
    getEmailProviderConfig().catch(() => null),
  ]);

  const githubFromEnv = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  return {
    email: !!email?.provider,
    "github-app": githubFromEnv || !!(github?.clientId && github?.clientSecret),
  };
}

// ---------------------------------------------------------------------------
// Admin page view
// ---------------------------------------------------------------------------

export type AuthMethodInfo = {
  method: AuthMethod;
  label: string;
  description: string;
  enabled: boolean;
  source: AuthMethodSource;
  /** True when an env var or vardo.yml pins the value and the admin page can't change it. */
  locked: boolean;
  /** Env var name that pins this method, shown alongside a locked toggle. */
  envVar: string;
  /** True when a prerequisite is missing, so turning it on changes nothing. */
  unavailable: boolean;
  /** Why it's unavailable, shown under the label. */
  unavailableReason?: string;
};

/** Every method with its state, source and prerequisite status. */
export async function getAllAuthMethods(): Promise<AuthMethodInfo[]> {
  const [layers, prerequisites] = await Promise.all([getAuthMethodLayers(), checkPrerequisites()]);

  return ALL_AUTH_METHODS.map((method) => {
    const config = METHOD_CONFIG[method];
    const { enabled, source, envVar } = resolveAuthMethod(method, layers);
    const requires = config.requires;
    const unavailable = requires ? !prerequisites[requires] : false;
    return {
      method,
      label: config.label,
      description: config.description,
      enabled,
      source,
      locked: source === "env" || source === "config",
      envVar,
      unavailable,
      unavailableReason: unavailable && requires ? PREREQUISITE_REASON[requires] : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Lockout guard
// ---------------------------------------------------------------------------

/**
 * Reject a write that would leave no usable sign-in method. Recovering from
 * that needs direct database access, so it's refused rather than warned about.
 * Returns an error message, or null when the write is safe.
 */
export async function assertMethodsRemain(
  changes: Partial<Record<AuthMethod, boolean>>,
): Promise<string | null> {
  const [layers, prerequisites] = await Promise.all([getAuthMethodLayers(), checkPrerequisites()]);

  const usable = ALL_AUTH_METHODS.filter((method) => {
    const enabled = changes[method] ?? resolveAuthMethod(method, layers).enabled;
    if (!enabled) return false;
    const requires = METHOD_CONFIG[method].requires;
    return requires ? prerequisites[requires] : true;
  });

  if (usable.length > 0) return null;
  return "At least one sign-in method has to stay usable. Turning this one off would lock everyone out of the instance.";
}

/** Method metadata (label, description, prerequisite). */
export function getAuthMethodConfig(method: AuthMethod): MethodConfig {
  return METHOD_CONFIG[method];
}
