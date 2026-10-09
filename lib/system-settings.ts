// System settings. Read order: vardo.yml, then DB system_settings, then default.

import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { decryptSystemOrFallback, encryptSystem } from "@/lib/crypto/encrypt";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";

import { DEFAULT_APP_NAME } from "@/lib/constants";

const log = logger.child("system-settings");

// Dynamic import keeps fs out of client bundles, which import this file for DEFAULT_APP_NAME.
async function getVardoConfig() {
  const { readVardoConfig } = await import("@/lib/config/vardo-config");
  return readVardoConfig();
}

// 30s in-memory cache of decrypted settings.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: string | null; expiresAt: number }>();

/** Read and decrypt a system_settings value, or null when absent. Cached for 30s. */
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

/** Invalidate the settings cache. Call after writing to system_settings. */
export function invalidateSettingsCache(key?: string) {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

/** Encrypt and upsert a system_settings row, then invalidate its cache entry. */
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

function parseJson<T>(raw: string, label: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.error(`Failed to parse ${label}`);
    return null;
  }
}

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

  return {
    instanceName: fileConfig?.instance?.name ?? dbConfig?.instanceName ?? DEFAULT_APP_NAME,
    baseDomain: fileConfig?.instance?.baseDomain ?? dbConfig?.baseDomain ?? "",
    serverIp: fileConfig?.instance?.serverIp ?? dbConfig?.serverIp ?? "",
    domain: fileConfig?.instance?.domain ?? dbConfig?.domain ?? "",
  };
}

/** Instance display name: instanceName, then domain, then null. */
export async function getInstanceDisplayName(): Promise<string | null> {
  const config = await getInstanceConfig();
  return config.instanceName || config.domain || null;
}

export type GitHubAppConfig = {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
};

export async function getGitHubAppConfig(): Promise<GitHubAppConfig | null> {
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

export type EmailProvider = "smtp" | "mailpace" | "resend" | "postmark" | "pouch";

export type EmailProviderConfig = {
  provider: EmailProvider;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
  /** Pouch only. Empty means https://pouch.email. */
  baseUrl?: string;
  /** Pouch only. Signing secret for delivery webhooks. */
  webhookSecret?: string;
};

export async function getEmailProviderConfig(): Promise<EmailProviderConfig | null> {
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
      baseUrl: fileConfig.email.baseUrl,
      webhookSecret: fileConfig.email.webhookSecret,
    };
  }

  const dbConfig = await getSystemSettingRaw("email_provider")
    .then((raw) => raw ? parseJson<EmailProviderConfig>(raw, "email_provider") : null);

  if (dbConfig) return dbConfig;

  return null;
}

export type BackupStorageConfig = {
  type: "s3" | "r2" | "b2" | "ssh";
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
};

export async function getBackupStorageConfig(): Promise<BackupStorageConfig | null> {
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

/** Feature flags from each source, unmerged. */
export async function getFeatureFlagLayers(): Promise<{
  config: Record<string, boolean>;
  database: Record<string, boolean>;
}> {
  const fileConfig = await getVardoConfig();
  const raw = await getSystemSettingRaw("feature_flags");
  return {
    config: fileConfig?.features ?? {},
    database: (raw ? parseJson<Record<string, boolean>>(raw, "feature_flags") : null) ?? {},
  };
}

/** Feature flags with vardo.yml layered over the DB, per key. */
export async function getFeatureFlagsConfig(): Promise<Record<string, boolean> | null> {
  const { config, database } = await getFeatureFlagLayers();
  const merged = { ...database, ...config };
  return Object.keys(merged).length > 0 ? merged : null;
}

export type SslIssuer = "le" | "google" | "zerossl";

export type SslConfig = {
  /** Active issuers in order. The first is the default resolver for new domains. */
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

/** The first active issuer, or "le". */
export function getPrimaryIssuer(config: SslConfig): SslIssuer {
  return config.activeIssuers[0] ?? "le";
}

/** Resolvers Traefik defines in docker-compose.yml. */
export const CERT_RESOLVERS = ["le", "le-dns", "google", "google-dns", "zerossl", "zerossl-dns"] as const;

/** Traefik has Cloudflare DNS credentials; it reads CF_DNS_API_TOKEN from the same .env as the console. */
export function hasCloudflareDns(): boolean {
  return !!process.env.CF_DNS_API_TOKEN?.trim();
}

/** Resolver for a new domain: the primary issuer, over DNS-01 when Cloudflare credentials are set. */
export function getDefaultCertResolver(config: SslConfig): string {
  const issuer = getPrimaryIssuer(config);
  return hasCloudflareDns() ? `${issuer}-dns` : issuer;
}

export async function getSslConfig(): Promise<SslConfig> {
  const fileConfig = await getVardoConfig();

  type StoredSslConfig = {
    activeIssuers?: string[];
    concurrentIssuers?: number;
    /** Legacy; migrated on read. */
    defaultIssuer?: string;
    challengeType?: string;
    dnsProvider?: "cloudflare";
    dnsApiToken?: string;
    zerosslEabKid?: string;
    zerosslEabHmac?: string;
  };

  const dbConfig = await getSystemSettingRaw("ssl_config")
    .then((raw) => raw ? parseJson<StoredSslConfig>(raw, "ssl_config") : null);

  // Config file, then DB, then legacy defaultIssuer, then "le".
  let activeIssuers: SslIssuer[];

  const fileIssuers = fileConfig?.ssl?.activeIssuers;
  if (fileIssuers && fileIssuers.length > 0) {
    activeIssuers = fileIssuers.filter((i): i is SslIssuer => VALID_ISSUERS.includes(i as SslIssuer));
  } else if (dbConfig?.activeIssuers && dbConfig.activeIssuers.length > 0) {
    activeIssuers = dbConfig.activeIssuers.filter((i): i is SslIssuer => VALID_ISSUERS.includes(i as SslIssuer));
  } else if (dbConfig?.defaultIssuer && VALID_ISSUERS.includes(dbConfig.defaultIssuer as SslIssuer)) {
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

export type AuthConfig = {
  registrationMode: "closed" | "open" | "approval";
  sessionDurationDays: number;
};

/** Sign-in method overrides from each source, unmerged. Resolved in lib/config/auth-methods. */
export async function getAuthMethodConfigLayers(): Promise<{
  config: Record<string, boolean>;
  database: Record<string, boolean>;
}> {
  const fileConfig = await getVardoConfig();
  const raw = await getSystemSettingRaw("auth_methods");
  return {
    config: fileConfig?.auth?.methods ?? {},
    database: (raw ? parseJson<Record<string, boolean>>(raw, "auth_methods") : null) ?? {},
  };
}

const VALID_REGISTRATION_MODES = ["closed", "open", "approval"] as const;

export async function getAuthConfig(): Promise<AuthConfig> {
  const fileConfig = await getVardoConfig();
  const dbConfig = await getSystemSettingRaw("auth_config")
    .then((raw) => raw ? parseJson<Partial<AuthConfig>>(raw, "auth_config") : null);

  const fileRegMode = fileConfig?.auth?.registrationMode;
  const validRegMode = fileRegMode && VALID_REGISTRATION_MODES.includes(fileRegMode)
    ? fileRegMode
    : undefined;

  return {
    registrationMode: validRegMode ?? dbConfig?.registrationMode ?? "closed",
    sessionDurationDays: fileConfig?.auth?.sessionDurationDays ?? dbConfig?.sessionDurationDays ?? 7,
  };
}

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
