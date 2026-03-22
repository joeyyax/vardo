// ---------------------------------------------------------------------------
// System settings helpers
//
// Reads system_settings rows from the database and decrypts them with
// decryptSystemOrFallback(). Callers should always prefer environment
// variables when set (so Docker / .env deployments keep working as before),
// and fall back to the DB-stored config written by the setup wizard.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { decryptSystemOrFallback } from "@/lib/crypto/encrypt";
import { eq } from "drizzle-orm";

// Short-TTL in-memory cache for system settings. These change rarely (admin
// panel only), so a 30s cache eliminates repeated DB hits when multiple config
// readers fan out within the same request or tick cycle.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: string | null; expiresAt: number }>();

/**
 * Read a system_settings row and decrypt its value.
 * Returns null if the row does not exist. Results are cached for 30s.
 */
async function getSystemSettingRaw(key: string): Promise<string | null> {
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
  const { encryptSystem } = await import("@/lib/crypto/encrypt");
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
// Instance config (general settings)
// ---------------------------------------------------------------------------

export type InstanceConfig = {
  instanceName: string;
  baseDomain: string;
  serverIp: string;
};

/**
 * Returns the instance configuration. Env vars take precedence; falls back
 * to the setup-wizard row in system_settings.
 */
export async function getInstanceConfig(): Promise<InstanceConfig> {
  // Env-var configured — no DB hit needed
  const envName = process.env.NEXT_PUBLIC_APP_NAME;
  const envDomain = process.env.HOST_BASE_DOMAIN;
  const envIp = process.env.HOST_SERVER_IP;

  if (envName || envDomain || envIp) {
    const dbConfig = await getInstanceConfigFromDb();
    return {
      instanceName: envName ?? dbConfig?.instanceName ?? "Vardo",
      baseDomain: envDomain ?? dbConfig?.baseDomain ?? "",
      serverIp: envIp ?? dbConfig?.serverIp ?? "",
    };
  }

  const dbConfig = await getInstanceConfigFromDb();
  return {
    instanceName: dbConfig?.instanceName ?? "Vardo",
    baseDomain: dbConfig?.baseDomain ?? "",
    serverIp: dbConfig?.serverIp ?? "",
  };
}

async function getInstanceConfigFromDb(): Promise<InstanceConfig | null> {
  const raw = await getSystemSettingRaw("instance_config");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as InstanceConfig;
  } catch {
    console.error("[system-settings] Failed to parse instance_config");
    return null;
  }
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

/**
 * Returns the GitHub App configuration. Env vars take precedence; falls back
 * to the setup-wizard row in system_settings.
 */
export async function getGitHubAppConfig(): Promise<GitHubAppConfig | null> {
  // If the core env vars are set, use them directly (no DB hit needed)
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY) {
    return {
      appId: process.env.GITHUB_APP_ID,
      appSlug: process.env.GITHUB_APP_SLUG ?? "",
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      privateKey: Buffer.from(process.env.GITHUB_PRIVATE_KEY, "base64").toString("utf-8"),
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    };
  }

  const raw = await getSystemSettingRaw("github_app");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as GitHubAppConfig;
  } catch {
    console.error("[system-settings] Failed to parse github_app config");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Email provider
// ---------------------------------------------------------------------------

export type EmailProviderConfig = {
  provider: "smtp" | "mailpace" | "resend";
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
};

/**
 * Returns the email provider configuration. Env vars take precedence; falls
 * back to the setup-wizard row in system_settings.
 */
export async function getEmailProviderConfig(): Promise<EmailProviderConfig | null> {
  // Env-var configured — no DB hit needed
  if (process.env.MAILPACE_API_TOKEN) {
    return {
      provider: "mailpace",
      apiKey: process.env.MAILPACE_API_TOKEN,
      fromEmail: process.env.EMAIL_FROM,
      fromName: undefined,
    };
  }

  const raw = await getSystemSettingRaw("email_provider");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as EmailProviderConfig;
  } catch {
    console.error("[system-settings] Failed to parse email_provider config");
    return null;
  }
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

/**
 * Returns the backup storage configuration from the setup-wizard row in
 * system_settings. (No env-var equivalent exists for backup storage.)
 */
export async function getBackupStorageConfig(): Promise<BackupStorageConfig | null> {
  const raw = await getSystemSettingRaw("backup_storage");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as BackupStorageConfig;
  } catch {
    console.error("[system-settings] Failed to parse backup_storage config");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Optional services
// ---------------------------------------------------------------------------

export type OptionalServicesConfig = {
  metrics: boolean;
  logs: boolean;
};

/**
 * Returns the optional services configuration from the setup-wizard row in
 * system_settings. Defaults to both disabled if not configured.
 */
export async function getOptionalServicesConfig(): Promise<OptionalServicesConfig> {
  const raw = await getSystemSettingRaw("optional_services");
  if (!raw) return { metrics: false, logs: false };

  try {
    const parsed = JSON.parse(raw);
    return { metrics: !!parsed.metrics, logs: !!parsed.logs };
  } catch {
    console.error("[system-settings] Failed to parse optional_services config");
    return { metrics: false, logs: false };
  }
}

// ---------------------------------------------------------------------------
// Feature flags (DB-stored overrides)
// ---------------------------------------------------------------------------

/**
 * Returns feature flag overrides stored in the database, or null if none
 * have been configured. Keys are FeatureFlag names, values are booleans.
 */
export async function getFeatureFlagsConfig(): Promise<Record<string, boolean> | null> {
  const raw = await getSystemSettingRaw("feature_flags");
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    console.error("[system-settings] Failed to parse feature_flags config");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authentication config
// ---------------------------------------------------------------------------

export type AuthConfig = {
  registrationMode: "closed" | "open" | "approval";
  sessionDurationDays: number;
};

/**
 * Returns the authentication configuration. Falls back to sensible defaults
 * (closed registration, 7-day sessions) if not configured.
 */
export async function getAuthConfig(): Promise<AuthConfig> {
  const raw = await getSystemSettingRaw("auth_config");
  if (!raw) return { registrationMode: "closed", sessionDurationDays: 7 };

  try {
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    return {
      registrationMode: parsed.registrationMode ?? "closed",
      sessionDurationDays: parsed.sessionDurationDays ?? 7,
    };
  } catch {
    console.error("[system-settings] Failed to parse auth_config");
    return { registrationMode: "closed", sessionDurationDays: 7 };
  }
}
