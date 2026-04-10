// ---------------------------------------------------------------------------
// System settings helpers
//
// Read order: config file (vardo.yml) → DB system_settings → hardcoded default.
// Config file takes highest priority when present. DB stores values set via
// the admin UI. No env var fallbacks — only DATABASE_URL, REDIS_URL, and
// NODE_ENV remain as env vars (infrastructure connections).
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { decryptSystemOrFallback, encryptSystem } from "@/lib/crypto/encrypt";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";

import { DEFAULT_APP_NAME } from "@/lib/constants";

const log = logger.child("system-settings");

// Dynamic import to avoid pulling fs (via vardo-config.ts) into client bundles.
// system-settings re-exports DEFAULT_APP_NAME which client components use,
// so all static imports in this file end up in client bundles.
async function getVardoConfig() {
  const { readVardoConfig } = await import("@/lib/config/vardo-config");
  return readVardoConfig();
}

// Short-TTL in-memory cache for system settings. These change rarely (admin
// panel only), so a 30s cache eliminates repeated DB + decrypt calls when
// multiple config readers fan out within the same request or tick cycle.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: string | null; expiresAt: number }>();

/**
 * Read a system_settings row and decrypt its value.
 * Returns null if the row does not exist. Results are cached for 30s.
 */
export async function getSystemSettingRaw(key: string): Promise<string | null> {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, key),
  });
  const value = row ? decryptSystemOrFallback(row.value).content || null : null;

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Invalidate the settings cache. Call after writing to system_settings
 * so subsequent reads pick up the new values immediately.
 */
export function invalidateSettingsCache(key?: string) {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

/**
 * Upsert a system_settings row and invalidate the cache for that key.
 * Encrypts the value before writing.
 */
export async function setSystemSetting(key: string, value: string) {
  const encrypted = encryptSystem(value);
  await db
    .insert(systemSettings)
    .values({ key, value: encrypted })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: encrypted, updatedAt: new Date() },
    });
  cache.delete(key);
}

// ---------------------------------------------------------------------------
// Helper: parse JSON from DB, return null on failure
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string, label: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.error(`Failed to parse ${label}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Instance config (general settings)
// ---------------------------------------------------------------------------

export type InstanceConfig = {
  instanceName: string;
  baseDomain: string;
  serverIp: string;
  domain: string;
};

export async function getInstanceConfig(): Promise<InstanceConfig> {
  const fileConfig = await getVardoConfig();
  const dbConfig = await getSystemSettingRaw("instance_config")
    .then((raw) => raw ? parseJson<InstanceConfig>(raw, "instance_config") : null);

  // Merge: config file fields > DB fields > defaults
  return {
    instanceName: fileConfig?.instance?.name ?? dbConfig?.instanceName ?? DEFAULT_APP_NAME,
    baseDomain: fileConfig?.instance?.baseDomain ?? dbConfig?.baseDomain ?? "",
    serverIp: fileConfig?.instance?.serverIp ?? dbConfig?.serverIp ?? "",
    domain: fileConfig?.instance?.domain ?? dbConfig?.domain ?? "",
  };
}

/**
 * Returns the configured display name for this instance: instanceName > domain > null.
 * Callers that always need a non-null value can provide a fallback, e.g. `os.hostname()`.
 */
export async function getInstanceDisplayName(): Promise<string | null> {
  const config = await getInstanceConfig();
  return config.instanceName || config.domain || null;
}

// ---------------------------------------------------------------------------
// GitHub App
// ---------------------------------------------------------------------------

export type GitHubAppConfig = {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
};

export async function getGitHubAppConfig(): Promise<GitHubAppConfig | null> {
  // Config file takes priority
  const fileConfig = await getVardoConfig();
  if (fileConfig?.github?.appId) {
    return {
      appId: fileConfig.github.appId,
      appSlug: fileConfig.github.appSlug ?? "",
      clientId: fileConfig.github.clientId ?? "",
      clientSecret: fileConfig.github.clientSecret ?? "",
      privateKey: fileConfig.github.privateKey ?? "",
      webhookSecret: fileConfig.github.webhookSecret ?? "",
    };
  }

  const dbConfig = await getSystemSettingRaw("github_app")
    .then((raw) => raw ? parseJson<GitHubAppConfig>(raw, "github_app") : null);

  if (dbConfig) return dbConfig;

  return null;
}

// ---------------------------------------------------------------------------
// Email provider
// ---------------------------------------------------------------------------

export type EmailProviderConfig = {
  provider: "smtp" | "mailpace" | "resend" | "postmark";
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
};

export async function getEmailProviderConfig(): Promise<EmailProviderConfig | null> {
  // Config file takes priority
  const fileConfig = await getVardoConfig();
  if (fileConfig?.email?.provider) {
    return {
      provider: fileConfig.email.provider,
      smtpHost: fileConfig.email.smtpHost,
      smtpPort: fileConfig.email.smtpPort,
      smtpUser: fileConfig.email.smtpUser,
      smtpPass: fileConfig.email.smtpPass,
      apiKey: fileConfig.email.apiKey,
      fromEmail: fileConfig.email.fromEmail,
      fromName: fileConfig.email.fromName,
    };
  }

  const dbConfig = await getSystemSettingRaw("email_provider")
    .then((raw) => raw ? parseJson<EmailProviderConfig>(raw, "email_provider") : null);

  if (dbConfig) return dbConfig;

  return null;
}

// ---------------------------------------------------------------------------
// Backup storage
// ---------------------------------------------------------------------------

export type BackupStorageConfig = {
  type: "s3" | "r2" | "b2" | "ssh";
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
};

export async function getBackupStorageConfig(): Promise<BackupStorageConfig | null> {
  // Config file takes priority
  const fileConfig = await getVardoConfig();
  if (fileConfig?.backup?.type) {
    return {
      type: fileConfig.backup.type,
      bucket: fileConfig.backup.bucket,
      region: fileConfig.backup.region,
      endpoint: fileConfig.backup.endpoint,
      accessKey: fileConfig.backup.accessKey,
      secretKey: fileConfig.backup.secretKey,
    };
  }

  const dbConfig = await getSystemSettingRaw("backup_storage")
    .then((raw) => raw ? parseJson<BackupStorageConfig>(raw, "backup_storage") : null);

  if (dbConfig) return dbConfig;

  return null;
}

// ---------------------------------------------------------------------------
// Feature flags (DB-stored overrides)
// ---------------------------------------------------------------------------

export async function getFeatureFlagsConfig(): Promise<Record<string, boolean> | null> {
  // Config file takes priority
  const fileConfig = await getVardoConfig();
  if (fileConfig?.features && Object.keys(fileConfig.features).length > 0) {
    return fileConfig.features;
  }

  const raw = await getSystemSettingRaw("feature_flags");
  if (!raw) return null;
  return parseJson<Record<string, boolean>>(raw, "feature_flags");
}

// ---------------------------------------------------------------------------
// SSL / ACME certificate issuer
// ---------------------------------------------------------------------------

export type SslIssuer = "le" | "google" | "zerossl";

export type SslConfig = {
  /**
   * Ordered list of active issuers. The first entry is used as the default
   * cert resolver for new domains. Multiple issuers can be active at once
   * so Traefik can issue certificates from any of them.
   */
  activeIssuers: SslIssuer[];
  /** How many issuers to try in parallel when obtaining a certificate. */
  concurrentIssuers: number;
  challengeType: "http" | "dns";
  dnsProvider?: "cloudflare";
  dnsApiToken?: string;
  zerosslEabKid?: string;
  zerosslEabHmac?: string;
};

export const VALID_ISSUERS = ["le", "google", "zerossl"] as const satisfies readonly SslIssuer[];
const VALID_CHALLENGE_TYPES = ["http", "dns"] as const;

export const ISSUER_LABELS: Record<SslIssuer, string> = {
  le: "Let's Encrypt",
  google: "Google Trust Services",
  zerossl: "ZeroSSL",
};

/**
 * The primary issuer — the first active issuer, or "le" as a safe default.
 * Use this when a single cert resolver value is needed (e.g. new domain defaults).
 */
export function getPrimaryIssuer(config: SslConfig): SslIssuer {
  return config.activeIssuers[0] ?? "le";
}

export async function getSslConfig(): Promise<SslConfig> {
  const fileConfig = await getVardoConfig();

  type StoredSslConfig = {
    activeIssuers?: string[];
    concurrentIssuers?: number;
    /** Legacy field — migrated on read */
    defaultIssuer?: string;
    challengeType?: string;
    dnsProvider?: "cloudflare";
    dnsApiToken?: string;
    zerosslEabKid?: string;
    zerosslEabHmac?: string;
  };

  const dbConfig = await getSystemSettingRaw("ssl_config")
    .then((raw) => raw ? parseJson<StoredSslConfig>(raw, "ssl_config") : null);

  // Resolve active issuers: config file > DB > legacy defaultIssuer field > default
  let activeIssuers: SslIssuer[];

  const fileIssuers = fileConfig?.ssl?.activeIssuers;
  if (fileIssuers && fileIssuers.length > 0) {
    activeIssuers = fileIssuers.filter((i): i is SslIssuer => VALID_ISSUERS.includes(i as SslIssuer));
  } else if (dbConfig?.activeIssuers && dbConfig.activeIssuers.length > 0) {
    activeIssuers = dbConfig.activeIssuers.filter((i): i is SslIssuer => VALID_ISSUERS.includes(i as SslIssuer));
  } else if (dbConfig?.defaultIssuer && VALID_ISSUERS.includes(dbConfig.defaultIssuer as SslIssuer)) {
    // Migrate legacy single-issuer config to array format
    activeIssuers = [dbConfig.defaultIssuer as SslIssuer];
  } else {
    activeIssuers = ["le"];
  }

  const rawConcurrent = fileConfig?.ssl?.concurrentIssuers ?? dbConfig?.concurrentIssuers ?? 1;
  const concurrentIssuers = Math.max(1, Math.min(rawConcurrent, activeIssuers.length || 1));

  const fileChallengeType = fileConfig?.ssl?.challengeType;
  const validChallengeType = fileChallengeType && VALID_CHALLENGE_TYPES.includes(fileChallengeType)
    ? fileChallengeType
    : undefined;

  return {
    activeIssuers,
    concurrentIssuers,
    challengeType: (validChallengeType ?? dbConfig?.challengeType ?? "http") as "http" | "dns",
    dnsProvider: fileConfig?.ssl?.dnsProvider ?? dbConfig?.dnsProvider,
    dnsApiToken: fileConfig?.ssl?.dnsApiToken ?? dbConfig?.dnsApiToken,
    zerosslEabKid: fileConfig?.ssl?.zerossl?.eabKid ?? dbConfig?.zerosslEabKid,
    zerosslEabHmac: fileConfig?.ssl?.zerossl?.eabHmac ?? dbConfig?.zerosslEabHmac,
  };
}

// ---------------------------------------------------------------------------
// Authentication config
// ---------------------------------------------------------------------------

export type AuthConfig = {
  registrationMode: "closed" | "open" | "approval";
  sessionDurationDays: number;
};

const VALID_REGISTRATION_MODES = ["closed", "open", "approval"] as const;

export async function getAuthConfig(): Promise<AuthConfig> {
  const fileConfig = await getVardoConfig();
  const dbConfig = await getSystemSettingRaw("auth_config")
    .then((raw) => raw ? parseJson<Partial<AuthConfig>>(raw, "auth_config") : null);

  // Validate registrationMode from config file
  const fileRegMode = fileConfig?.auth?.registrationMode;
  const validRegMode = fileRegMode && VALID_REGISTRATION_MODES.includes(fileRegMode)
    ? fileRegMode
    : undefined;

  // Merge: config file fields > DB fields > defaults
  return {
    registrationMode: validRegMode ?? dbConfig?.registrationMode ?? "closed",
    sessionDurationDays: fileConfig?.auth?.sessionDurationDays ?? dbConfig?.sessionDurationDays ?? 7,
  };
}

// ---------------------------------------------------------------------------
// Error tracking (GlitchTip)
// ---------------------------------------------------------------------------

export type ErrorTrackingConfig = {
  /** API token for GlitchTip. */
  apiToken: string;
  /** Internal URL for server→GlitchTip API calls. Defaults to Docker DNS (vardo-glitchtip:8000). */
  url?: string;
  /** Browser-accessible URL for issue permalinks. */
  publicUrl?: string;
};

export async function getErrorTrackingConfig(): Promise<ErrorTrackingConfig | null> {
  const fileConfig = await getVardoConfig();
  if (fileConfig?.errorTracking?.apiToken) {
    return {
      apiToken: fileConfig.errorTracking.apiToken,
      url: fileConfig.errorTracking.publicUrl, // config file doesn't distinguish internal/public
      publicUrl: fileConfig.errorTracking.publicUrl,
    };
  }

  const dbConfig = await getSystemSettingRaw("error_tracking")
    .then((raw) => raw ? parseJson<ErrorTrackingConfig>(raw, "error_tracking") : null);

  if (dbConfig) return dbConfig;

  return null;
}

// ---------------------------------------------------------------------------
// Traefik config
// ---------------------------------------------------------------------------

export type TraefikConfig = {
  externalRouting: boolean;
};

export async function getTraefikConfig(): Promise<TraefikConfig> {
  const raw = await getSystemSettingRaw("traefik_config");
  const dbConfig = raw ? parseJson<TraefikConfig>(raw, "traefik_config") : null;

  return {
    externalRouting: dbConfig?.externalRouting ?? false,
  };
}
