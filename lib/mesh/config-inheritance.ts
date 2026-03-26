import { setSystemSetting, getFeatureFlagsConfig } from "@/lib/system-settings";

type InheritedConfig = {
  email: boolean;
  backup: boolean;
  github: boolean;
};

/**
 * Pull shareable config from a mesh hub and store it locally.
 * Best-effort — returns which sections were successfully inherited.
 */
export async function inheritConfigFromHub(
  hubApiUrl: string,
  hubToken: string,
): Promise<InheritedConfig> {
  const inherited: InheritedConfig = { email: false, backup: false, github: false };

  const configRes = await fetch(`${hubApiUrl}/api/v1/mesh/config`, {
    headers: { Authorization: `Bearer ${hubToken}` },
  });

  if (!configRes.ok) return inherited;

  const config = await configRes.json();

  if (config.email) {
    await setSystemSetting("email_provider", JSON.stringify(config.email));
    inherited.email = true;
  }
  if (config.backup) {
    await setSystemSetting("backup_storage", JSON.stringify(config.backup));
    inherited.backup = true;
  }
  if (config.github) {
    await setSystemSetting("github_app", JSON.stringify(config.github));
    inherited.github = true;
  }
  if (config.ssl) {
    await setSystemSetting("ssl_config", JSON.stringify(config.ssl));
  }

  // Merge feature flags — don't overwrite local flags, only add missing ones
  if (config.features) {
    const localFlags = (await getFeatureFlagsConfig()) ?? {};
    const merged = { ...config.features, ...localFlags };
    await setSystemSetting("feature_flags", JSON.stringify(merged));
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
