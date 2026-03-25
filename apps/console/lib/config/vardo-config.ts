/**
 * Vardo config file loader.
 *
 * Two files:
 *   vardo.yml         — settings (shareable, safe to commit)
 *   vardo.secrets.yml — keys and passwords (0600, gitignored)
 *
 * Resolution: config file > DB system_settings > default
 */

import { readFile, writeFile, chmod, access } from "fs/promises";
import { resolve } from "path";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VardoConfig = {
  instance?: {
    id?: string;
    name?: string;
    domain?: string;
    baseDomain?: string;
    serverIp?: string;
  };
  auth?: {
    registrationMode?: "closed" | "open" | "approval";
    sessionDurationDays?: number;
  };
  email?: {
    provider?: "smtp" | "mailpace" | "resend" | "postmark";
    fromEmail?: string;
    fromName?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
  };
  backup?: {
    type?: "s3" | "r2" | "b2" | "ssh";
    bucket?: string;
    region?: string;
    endpoint?: string;
  };
  github?: {
    appId?: string;
    appSlug?: string;
    clientId?: string;
  };
  features?: Record<string, boolean>;
};

export type VardoSecrets = {
  encryptionKey?: string;
  authSecret?: string;
  acmeEmail?: string;
  email?: {
    apiKey?: string;
    smtpPass?: string;
  };
  backup?: {
    accessKey?: string;
    secretKey?: string;
  };
  github?: {
    clientSecret?: string;
    privateKey?: string;
    webhookSecret?: string;
  };
};

/** Config + secrets merged for internal use. */
export type VardoFullConfig = {
  instance?: VardoConfig["instance"];
  auth?: VardoConfig["auth"];
  email?: VardoConfig["email"] & VardoSecrets["email"];
  backup?: VardoConfig["backup"] & VardoSecrets["backup"];
  github?: VardoConfig["github"] & VardoSecrets["github"];
  features?: VardoConfig["features"];
  secrets?: {
    encryptionKey?: string;
    authSecret?: string;
    acmeEmail?: string;
  };
};

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

function configDir(): string {
  return process.env.VARDO_CONFIG_DIR || process.cwd();
}

function configPath(): string {
  return resolve(configDir(), "vardo.yml");
}

function secretsPath(): string {
  return resolve(configDir(), "vardo.secrets.yml");
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
let configCache: { value: VardoFullConfig | null; expiresAt: number } | null = null;

export function invalidateConfigCache() {
  configCache = null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readYaml<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, "utf-8");
    return YAML.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Read and merge both config files. Cached for 30s.
 * Returns null if no config file exists.
 */
export async function readVardoConfig(): Promise<VardoFullConfig | null> {
  if (configCache && Date.now() < configCache.expiresAt) {
    return configCache.value;
  }

  const configExists = await fileExists(configPath());
  if (!configExists) {
    configCache = { value: null, expiresAt: Date.now() + CACHE_TTL_MS };
    return null;
  }

  const config = await readYaml<VardoConfig>(configPath());
  const secrets = await readYaml<VardoSecrets>(secretsPath());

  if (!config) {
    configCache = { value: null, expiresAt: Date.now() + CACHE_TTL_MS };
    return null;
  }

  // Merge secrets into config
  const merged: VardoFullConfig = {
    instance: config.instance,
    auth: config.auth,
    email: { ...config.email, ...secrets?.email },
    backup: { ...config.backup, ...secrets?.backup },
    github: { ...config.github, ...secrets?.github },
    features: config.features,
    secrets: {
      encryptionKey: secrets?.encryptionKey,
      authSecret: secrets?.authSecret,
      acmeEmail: secrets?.acmeEmail,
    },
  };

  configCache = { value: merged, expiresAt: Date.now() + CACHE_TTL_MS };
  return merged;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write config and secrets to their respective files.
 * Secrets file gets 0600 permissions.
 */
export async function writeVardoConfig(
  config: VardoConfig,
  secrets: VardoSecrets
): Promise<void> {
  const configYaml = YAML.stringify(config, { indent: 2 });
  const secretsYaml = YAML.stringify(secrets, { indent: 2 });

  await writeFile(configPath(), configYaml, "utf-8");
  await writeFile(secretsPath(), secretsYaml, "utf-8");
  await chmod(secretsPath(), 0o600);

  invalidateConfigCache();
}

// ---------------------------------------------------------------------------
// Export: collect current settings into config objects
// ---------------------------------------------------------------------------

/**
 * Build exportable config + secrets from current system state.
 * Reads from DB system_settings (the canonical store).
 */
export async function systemSettingsToVardoConfig(): Promise<{
  config: VardoConfig;
  secrets: VardoSecrets;
}> {
  // Dynamic imports to avoid circular deps
  const {
    getInstanceConfig,
    getAuthConfig,
    getEmailProviderConfig,
    getBackupStorageConfig,
    getGitHubAppConfig,
    getFeatureFlagsConfig,
  } = await import("@/lib/system-settings");
  const { getInstanceId } = await import("@/lib/constants");

  const [instance, auth, email, backup, github, features] = await Promise.all([
    getInstanceConfig(),
    getAuthConfig(),
    getEmailProviderConfig(),
    getBackupStorageConfig(),
    getGitHubAppConfig(),
    getFeatureFlagsConfig(),
  ]);

  let instanceId: string | undefined;
  try {
    instanceId = await getInstanceId();
  } catch {
    // not set
  }

  const config: VardoConfig = {
    instance: {
      id: instanceId,
      name: instance.instanceName,
      domain: process.env.VARDO_DOMAIN || undefined,
      baseDomain: instance.baseDomain || undefined,
      serverIp: instance.serverIp || undefined,
    },
    auth: {
      registrationMode: auth.registrationMode,
      sessionDurationDays: auth.sessionDurationDays,
    },
    ...(email && {
      email: {
        provider: email.provider,
        fromEmail: email.fromEmail,
        fromName: email.fromName,
        smtpHost: email.smtpHost,
        smtpPort: email.smtpPort,
        smtpUser: email.smtpUser,
      },
    }),
    ...(backup && {
      backup: {
        type: backup.type,
        bucket: backup.bucket,
        region: backup.region,
        endpoint: backup.endpoint,
      },
    }),
    ...(github && {
      github: {
        appId: github.appId,
        appSlug: github.appSlug,
        clientId: github.clientId,
      },
    }),
    ...(features && { features }),
  };

  const vardoSecrets: VardoSecrets = {
    encryptionKey: process.env.ENCRYPTION_MASTER_KEY || undefined,
    authSecret: process.env.BETTER_AUTH_SECRET || undefined,
    acmeEmail: process.env.ACME_EMAIL || undefined,
    ...(email && {
      email: {
        apiKey: email.apiKey,
        smtpPass: email.smtpPass,
      },
    }),
    ...(backup && {
      backup: {
        accessKey: backup.accessKey,
        secretKey: backup.secretKey,
      },
    }),
    ...(github && {
      github: {
        clientSecret: github.clientSecret,
        privateKey: github.privateKey,
        webhookSecret: github.webhookSecret,
      },
    }),
  };

  return { config, secrets: vardoSecrets };
}

// ---------------------------------------------------------------------------
// Import: write config sections to system_settings DB
// ---------------------------------------------------------------------------

/**
 * Import a config into system_settings.
 * Returns the list of sections that were imported.
 */
export async function importVardoConfig(
  full: VardoFullConfig
): Promise<string[]> {
  const { setSystemSetting, invalidateSettingsCache } = await import(
    "@/lib/system-settings"
  );

  const imported: string[] = [];

  if (full.instance) {
    await setSystemSetting(
      "instance_config",
      JSON.stringify({
        instanceName: full.instance.name,
        baseDomain: full.instance.baseDomain,
        serverIp: full.instance.serverIp,
      })
    );
    imported.push("instance");
  }

  if (full.auth) {
    await setSystemSetting("auth_config", JSON.stringify(full.auth));
    imported.push("auth");
  }

  if (full.email) {
    await setSystemSetting("email_provider", JSON.stringify(full.email));
    imported.push("email");
  }

  if (full.backup) {
    await setSystemSetting(
      "backup_storage",
      JSON.stringify({
        type: full.backup.type,
        bucket: full.backup.bucket,
        region: full.backup.region,
        endpoint: full.backup.endpoint,
        accessKey: full.backup.accessKey,
        secretKey: full.backup.secretKey,
      })
    );
    imported.push("backup");
  }

  if (full.github) {
    await setSystemSetting("github_app", JSON.stringify(full.github));
    imported.push("github");
  }

  if (full.features) {
    await setSystemSetting("feature_flags", JSON.stringify(full.features));
    imported.push("features");
  }

  invalidateSettingsCache();
  invalidateConfigCache();
  return imported;
}

/**
 * Check if a config file exists on disk.
 */
export async function configFileExists(): Promise<{
  config: boolean;
  secrets: boolean;
  configPath: string;
  secretsPath: string;
}> {
  return {
    config: await fileExists(configPath()),
    secrets: await fileExists(secretsPath()),
    configPath: configPath(),
    secretsPath: secretsPath(),
  };
}
