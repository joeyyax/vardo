// Channel credentials are encrypted at rest under the org key, one field at a time.

import { decryptOrFallback, encrypt, isEncrypted } from "@/lib/crypto/encrypt";
import { maskChannelConfig } from "./mask-config";

type ChannelConfig = Record<string, unknown>;

/** Config fields that are credentials. */
export const CHANNEL_SECRET_KEYS = ["url", "secret", "webhookUrl"] as const;

function mapSecrets<T>(config: T, fn: (value: string) => string): T {
  const out = { ...(config as ChannelConfig) };
  for (const key of CHANNEL_SECRET_KEYS) {
    const value = out[key];
    if (typeof value === "string" && value !== "") out[key] = fn(value);
  }
  return out as T;
}

/** Encrypt the credential fields that aren't already ciphertext. */
export function sealChannelConfig<T>(config: T, organizationId: string): T {
  return mapSecrets(config, (value) => (isEncrypted(value) ? value : encrypt(value, organizationId)));
}

export class ChannelDecryptError extends Error {
  constructor(channelName: string) {
    super(`Config for notification channel "${channelName}" can't be decrypted with the running ENCRYPTION_MASTER_KEY`);
    this.name = "ChannelDecryptError";
  }
}

/** Plaintext config for sending. Throws when a credential won't decrypt. */
export function openChannelConfig(channel: { name?: string; organizationId: string; config: unknown }): ChannelConfig {
  return mapSecrets(channel.config as ChannelConfig, (value) => {
    const result = decryptOrFallback(value, channel.organizationId);
    if (result.decryptFailed) throw new ChannelDecryptError(channel.name ?? "unnamed");
    return result.content;
  });
}

/** A channel row safe to return to any caller: decrypted, then masked. */
export function presentChannel<T extends { type: string; organizationId: string; config: unknown }>(channel: T): T {
  const config = mapSecrets(channel.config as ChannelConfig, (value) => {
    const result = decryptOrFallback(value, channel.organizationId);
    return result.decryptFailed ? "" : result.content;
  });
  return maskChannelConfig({ ...channel, config });
}

/** Credential fields still stored as plaintext. */
export function plaintextChannelSecretKeys(config: unknown): string[] {
  const c = (config ?? {}) as ChannelConfig;
  return CHANNEL_SECRET_KEYS.filter(
    (key) => typeof c[key] === "string" && c[key] !== "" && !isEncrypted(c[key] as string),
  );
}

/** Ciphertext credential fields, with whether the running key opens each. */
export function probeChannelSecrets(channel: { organizationId: string; config: unknown }): {
  encrypted: number;
  undecryptable: number;
} {
  const c = (channel.config ?? {}) as ChannelConfig;
  let encrypted = 0;
  let undecryptable = 0;
  for (const key of CHANNEL_SECRET_KEYS) {
    const value = c[key];
    if (typeof value !== "string" || !isEncrypted(value)) continue;
    encrypted++;
    if (decryptOrFallback(value, channel.organizationId).decryptFailed) undecryptable++;
  }
  return { encrypted, undecryptable };
}
