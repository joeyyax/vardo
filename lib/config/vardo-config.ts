/**
 * Loads vardo.yml (settings, safe to commit) and vardo.secrets.yml (0600, gitignored).
 * Resolution: config file, then DB system_settings, then default.
 */

import { readFile, writeFile, chmod, access } from "fs/promises";
import { resolve } from "path";
import YAML from "yaml";
import type { EmailProvider } from "@/lib/system-settings";

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
    /** Sign-in methods, keyed by method name: password, passkey, magic-link, totp, github. */
    methods?: Record<string, boolean>;
  };
  email?: {
    provider?: EmailProvider;
    fromEmail?: string;
    fromName?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    baseUrl?: string;
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
  ssl?: {
    /** Active ACME issuers in order. The first is the default for new domains. */
    activeIssuers?: ("le" | "google" | "zerossl")[];
    /** How many issuers to try in parallel when obtaining a certificate. */
    concurrentIssuers?: number;
    /** @deprecated Use activeIssuers instead. Migrated on read. */
    defaultIssuer?: "le" | "google" | "zerossl";
    challengeType?: "http" | "dns";
    dnsProvider?: "cloudflare";
  };
  features?: Record<string, boolean>;

  // Project fields, from vardo.yml in a user's app repo
  project?: {
    name?: string;
    environments?: Record<
      string,
      {
        domain?: string;
        /** Services to exclude from compose processing (e.g., ["caddy"]) */
        exclude?: string[];
      }
    >;
    /** Env var names the app expects (documentation, not values) */
    env?: string[];
    resources?: {
      memory?: string;
      cpus?: string;
    };
  };
};

/** Per-environment config from a user's vardo.yml project section. */
export type VardoEnvConfig = {
  domain?: string;
  exclude?: string[];
  networking?: {
    domain?: string;
    ssl?: boolean;
    redirects?: string[];
  };
};

export type VardoSecrets = {
  encryptionKey?: string;
  authSecret?: string;
  acmeEmail?: string;
  email?: {
    apiKey?: string;
    smtpPass?: string;
    webhookSecret?: string;
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
  zerossl?: {
    eabKid?: string;
    eabHmac?: string;
  };
  dns?: {
    apiToken?: string;
  };
};

/** Config + secrets merged for internal use. */
export type VardoFullConfig = {
  instance?: VardoConfig["instance"];
  auth?: VardoConfig["auth"];
  email?: VardoConfig["email"] & VardoSecrets["email"];
  backup?: VardoConfig["backup"] & VardoSecrets["backup"];
  github?: VardoConfig["github"] & VardoSecrets["github"];
  ssl?: VardoConfig["ssl"] & { zerossl?: VardoSecrets["zerossl"]; dnsApiToken?: string };
  features?: VardoConfig["features"];
  secrets?: {
    encryptionKey?: string;
    authSecret?: string;
    acmeEmail?: string;
  };
};

function configDir(): string {
  return process.env.VARDO_CONFIG_DIR || process.cwd();
}

function configPath(): string {
  return resolve(configDir(), "vardo.yml");
}

function secretsPath(): string {
  return resolve(configDir(), "vardo.secrets.yml");
}

const CACHE_TTL_MS = 30_000;
let configCache: { value: VardoFullConfig | null; expiresAt: number } | null = null;

export function invalidateConfigCache() {
  configCache = null;
}

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

/** Read and merge both config files, cached for 30s. Null without a config file. */
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

  const merged: VardoFullConfig = {
    instance: config.instance,
    auth: config.auth,
    email: { ...config.email, ...secrets?.email },
    backup: { ...config.backup, ...secrets?.backup },
    github: { ...config.github, ...secrets?.github },
    ssl: { ...config.ssl, zerossl: secrets?.zerossl, dnsApiToken: secrets?.dns?.apiToken },
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

/** Write config and secrets files. The secrets file gets 0600. */
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

/** Build exportable config and secrets from DB system_settings. */
export async function systemSettingsToVardoConfig(): Promise<{
  config: VardoConfig;
  secrets: VardoSecrets;
}> {
  // Dynamic imports avoid circular deps.
  const {
    getInstanceConfig,
    getAuthConfig,
    getEmailProviderConfig,
    getBackupStorageConfig,
    getGitHubAppConfig,
    getSslConfig,
    getFeatureFlagsConfig,
  } = await import("@/lib/system-settings");
  const { getInstanceId } = await import("@/lib/constants");
  const { getAuthMethodStates } = await import("@/lib/config/auth-methods");

  const [instance, auth, email, backup, github, ssl, features, methods] = await Promise.all([
    getInstanceConfig(),
    getAuthConfig(),
    getEmailProviderConfig(),
    getBackupStorageConfig(),
    getGitHubAppConfig(),
    getSslConfig(),
    getFeatureFlagsConfig(),
    getAuthMethodStates(),
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
      domain: instance.domain || undefined,
      baseDomain: instance.baseDomain || undefined,
      serverIp: instance.serverIp || undefined,
    },
    auth: {
      registrationMode: auth.registrationMode,
      sessionDurationDays: auth.sessionDurationDays,
      methods,
    },
    ...(email && {
      email: {
        provider: email.provider,
        fromEmail: email.fromEmail,
        fromName: email.fromName,
        smtpHost: email.smtpHost,
        smtpPort: email.smtpPort,
        smtpUser: email.smtpUser,
        baseUrl: email.baseUrl,
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
    ...((ssl.activeIssuers.length > 1 || ssl.activeIssuers[0] !== "le" || ssl.concurrentIssuers > 1) && {
      ssl: {
        activeIssuers: ssl.activeIssuers,
        ...(ssl.concurrentIssuers > 1 && { concurrentIssuers: ssl.concurrentIssuers }),
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
        webhookSecret: email.webhookSecret,
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
    ...((ssl.zerosslEabKid || ssl.zerosslEabHmac) && {
      zerossl: {
        eabKid: ssl.zerosslEabKid,
        eabHmac: ssl.zerosslEabHmac,
      },
    }),
  };

  return { config, secrets: vardoSecrets };
}

/** Import a config into system_settings. Returns the imported sections. */
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
    const { methods, ...authConfig } = full.auth;
    await setSystemSetting("auth_config", JSON.stringify(authConfig));
    imported.push("auth");

    if (methods) {
      await setSystemSetting("auth_methods", JSON.stringify(methods));
      imported.push("auth methods");
    }
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

  if (full.ssl) {
    const activeIssuers = full.ssl.activeIssuers?.length
      ? full.ssl.activeIssuers
      : full.ssl.defaultIssuer
        ? [full.ssl.defaultIssuer]
        : ["le"];

    await setSystemSetting("ssl_config", JSON.stringify({
      activeIssuers,
      concurrentIssuers: full.ssl.concurrentIssuers ?? 1,
      zerosslEabKid: full.ssl.zerossl?.eabKid,
      zerosslEabHmac: full.ssl.zerossl?.eabHmac,
    }));
    imported.push("ssl");
  }

  if (full.features) {
    await setSystemSetting("feature_flags", JSON.stringify(full.features));
    imported.push("features");
  }

  invalidateSettingsCache();
  invalidateConfigCache();
  return imported;
}

/** The project section of a directory's vardo.yml, or null. */
export async function readProjectConfig(
  dir: string
): Promise<VardoConfig["project"] | null> {
  const path = resolve(dir, "vardo.yml");
  if (!(await fileExists(path))) return null;
  const config = await readYaml<VardoConfig>(path);
  return config?.project ?? null;
}

/** Whether the config and secrets files exist on disk. */

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
