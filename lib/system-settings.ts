// ---------------------------------------------------------------------------
// System settings helpers
//
// Read order: DB system_settings → env var → hardcoded default.
// Once a setting is saved via the UI, the DB value takes precedence
// permanently. Env vars act as seed/default for Docker/.env deployments.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { decryptSystemOrFallback, encryptSystem } from "@/lib/crypto/encrypt";
import { eq } from "drizzle-orm";

// Short-TTL in-memory cache for system settings. These change rarely (admin
// panel only), so a 30s cache eliminates repeated DB + decrypt calls when
// multiple config readers fan out within the same request or tick cycle.
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
    console.error(`[system-settings] Failed to parse ${label}`);
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
};

export async function getInstanceConfig(): Promise<InstanceConfig> {
  const dbConfig = await getSystemSettingRaw("instance_config")
    .then((raw) => raw ? parseJson<InstanceConfig>(raw, "instance_config") : null);

  if (dbConfig) return dbConfig;

  // Env var fallback
  return {
    instanceName: process.env.NEXT_PUBLIC_APP_NAME ?? "Vardo",
    baseDomain: process.env.HOST_BASE_DOMAIN ?? "",
    serverIp: process.env.HOST_SERVER_IP ?? "",
  };
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
  const dbConfig = await getSystemSettingRaw("github_app")
    .then((raw) => raw ? parseJson<GitHubAppConfig>(raw, "github_app") : null);

  if (dbConfig) return dbConfig;

  // Env var fallback
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

  return null;
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

export async function getEmailProviderConfig(): Promise<EmailProviderConfig | null> {
  const dbConfig = await getSystemSettingRaw("email_provider")
    .then((raw) => raw ? parseJson<EmailProviderConfig>(raw, "email_provider") : null);

  if (dbConfig) return dbConfig;

  // Env var fallback — detect provider from available keys
  if (process.env.RESEND_API_KEY) {
    return {
      provider: "resend",
      apiKey: process.env.RESEND_API_KEY,
      fromEmail: process.env.EMAIL_FROM,
      fromName: process.env.EMAIL_FROM_NAME,
    };
  }

  if (process.env.MAILPACE_API_TOKEN) {
    return {
      provider: "mailpace",
      apiKey: process.env.MAILPACE_API_TOKEN,
      fromEmail: process.env.EMAIL_FROM,
      fromName: process.env.EMAIL_FROM_NAME,
    };
  }

  if (process.env.SMTP_HOST) {
    return {
      provider: "smtp",
      smtpHost: process.env.SMTP_HOST,
      smtpPort: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined,
      smtpUser: process.env.SMTP_USER,
      smtpPass: process.env.SMTP_PASS,
      fromEmail: process.env.EMAIL_FROM,
      fromName: process.env.EMAIL_FROM_NAME,
    };
  }

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
  const dbConfig = await getSystemSettingRaw("backup_storage")
    .then((raw) => raw ? parseJson<BackupStorageConfig>(raw, "backup_storage") : null);

  if (dbConfig) return dbConfig;

  // Env var fallback
  const storageType = process.env.BACKUP_STORAGE_TYPE as BackupStorageConfig["type"] | undefined;
  if (storageType && process.env.BACKUP_STORAGE_BUCKET) {
    return {
      type: storageType,
      bucket: process.env.BACKUP_STORAGE_BUCKET,
      region: process.env.BACKUP_STORAGE_REGION,
      endpoint: process.env.BACKUP_STORAGE_ENDPOINT,
      accessKey: process.env.BACKUP_STORAGE_ACCESS_KEY,
      secretKey: process.env.BACKUP_STORAGE_SECRET_KEY,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Optional services
// ---------------------------------------------------------------------------

export type OptionalServicesConfig = {
  metrics: boolean;
  logs: boolean;
};

export async function getOptionalServicesConfig(): Promise<OptionalServicesConfig> {
  const dbConfig = await getSystemSettingRaw("optional_services")
    .then((raw) => raw ? parseJson<OptionalServicesConfig>(raw, "optional_services") : null);

  if (dbConfig) return { metrics: !!dbConfig.metrics, logs: !!dbConfig.logs };

  // Env var fallback
  return {
    metrics: process.env.FEATURE_METRICS === "true",
    logs: process.env.FEATURE_LOGS === "true",
  };
}

// ---------------------------------------------------------------------------
// Feature flags (DB-stored overrides)
// ---------------------------------------------------------------------------

export async function getFeatureFlagsConfig(): Promise<Record<string, boolean> | null> {
  const raw = await getSystemSettingRaw("feature_flags");
  if (!raw) return null;
  return parseJson<Record<string, boolean>>(raw, "feature_flags");
}

// ---------------------------------------------------------------------------
// Authentication config
// ---------------------------------------------------------------------------

export type AuthConfig = {
  registrationMode: "closed" | "open" | "approval";
  sessionDurationDays: number;
};

// No env var fallback — auth config is security-sensitive (registration mode,
// session duration) and should only be set explicitly via the admin UI.
export async function getAuthConfig(): Promise<AuthConfig> {
  const dbConfig = await getSystemSettingRaw("auth_config")
    .then((raw) => raw ? parseJson<Partial<AuthConfig>>(raw, "auth_config") : null);

  return {
    registrationMode: dbConfig?.registrationMode ?? "closed",
    sessionDurationDays: dbConfig?.sessionDurationDays ?? 7,
  };
}
