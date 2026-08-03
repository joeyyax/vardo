import {
  setSystemSetting,
  getFeatureFlagsConfig,
  getEmailProviderConfig,
  getBackupStorageConfig,
  getGitHubAppConfig,
  getSslConfig,
} from "@/lib/system-settings";

export type InheritedConfig = {
  email: boolean;
  backup: boolean;
  github: boolean;
  /** Sections inherited without their credential — an admin must supply it locally. */
  credentialsRequired: string[];
};

export const EMPTY_INHERITED_CONFIG: InheritedConfig = {
  email: false,
  backup: false,
  github: false,
  credentialsRequired: [],
};

/**
 * Pull shareable config from a mesh hub and store it locally.
 *
 * The hub serves no credentials, so an inherited section is unusable until an
 * admin adds the secret here. Sections already configured locally are left alone
 * rather than overwritten with a credential-free copy.
 */
export async function inheritConfigFromHub(
  hubApiUrl: string,
  hubToken: string,
): Promise<InheritedConfig> {
  const inherited: InheritedConfig = { ...EMPTY_INHERITED_CONFIG, credentialsRequired: [] };

  const configRes = await fetch(`${hubApiUrl}/api/v1/mesh/config`, {
    headers: { Authorization: `Bearer ${hubToken}` },
  });

  if (!configRes.ok) return inherited;

  const config = await configRes.json();

  if (config.email && !(await getEmailProviderConfig())) {
    await setSystemSetting("email_provider", JSON.stringify(config.email));
    inherited.email = true;
  }
  if (config.backup && !(await getBackupStorageConfig())) {
    await setSystemSetting("backup_storage", JSON.stringify(config.backup));
    inherited.backup = true;
  }
  if (config.github && !(await getGitHubAppConfig())) {
    await setSystemSetting("github_app", JSON.stringify(config.github));
    inherited.github = true;
  }

  // Keep any local ACME credential — the hub never sends one.
  if (config.ssl) {
    const local = await getSslConfig();
    if (!local.dnsApiToken && !local.zerosslEabKid) {
      await setSystemSetting("ssl_config", JSON.stringify(config.ssl));
    }
  }

  // Merge feature flags — don't overwrite local flags, only add missing ones
  if (config.features) {
    const localFlags = (await getFeatureFlagsConfig()) ?? {};
    const merged = { ...config.features, ...localFlags };
    await setSystemSetting("feature_flags", JSON.stringify(merged));
  }

  if (Array.isArray(config.credentialsRequired)) {
    inherited.credentialsRequired = config.credentialsRequired.filter(
      (s: unknown): s is string => typeof s === "string",
    );
  }

  return inherited;
}

const PRIVATE_IP_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]/,
  /^\[fe80:/,
  /^\[fd/,
];

/**
 * Validate a hub API URL — must be HTTPS (or HTTP for local dev)
 * and must not point to private/link-local IP ranges.
 */
export function validateHubUrl(rawUrl: string): { valid: boolean; error?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { valid: false, error: "Invalid hub URL" };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { valid: false, error: "Invalid hub URL protocol" };
  }

  const hostname = url.hostname;
  if (PRIVATE_IP_RANGES.some((r) => r.test(hostname))) {
    return { valid: false, error: "Hub URL must not point to a private IP address" };
  }

  return { valid: true };
}
