// ---------------------------------------------------------------------------
// Backup target config: validation, encryption at rest and masking.
//
// Each credential field is encrypted on its own so the rest of the config stays
// readable. Org targets use the org key; instance targets (no org) use the
// system key.
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  decryptOrFallback,
  decryptSystemOrFallback,
  encrypt,
  encryptSystem,
  isEncrypted,
} from "@/lib/crypto/encrypt";
import { MASK_SENTINEL, isMasked } from "@/lib/mask-secrets";

export type TargetType = "s3" | "r2" | "b2" | "ssh" | "local";
export type TargetConfig = Record<string, unknown>;

/** Config fields that are credentials. */
export const TARGET_SECRET_KEYS = [
  "accessKeyId",
  "secretAccessKey",
  "privateKey",
  "password",
  "passphrase",
] as const;

const isSecretKey = (key: string) => (TARGET_SECRET_KEYS as readonly string[]).includes(key);

// A masked value is a placeholder, never a credential.
const secretString = z
  .string()
  .min(1)
  .refine((v) => !isMasked(v), "Enter the credential; a masked value can't be saved");

const s3ConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().optional(),
  accessKeyId: secretString,
  secretAccessKey: secretString,
  prefix: z.string().optional(),
});

const sshConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  username: z.string().min(1),
  privateKey: secretString.optional(),
  path: z.string().min(1),
});

const localConfigSchema = z.object({
  path: z.string().min(1, "Path is required"),
});

const CONFIG_SCHEMAS = {
  s3: s3ConfigSchema,
  r2: s3ConfigSchema,
  b2: s3ConfigSchema,
  ssh: sshConfigSchema,
  local: localConfigSchema,
} as const;

export function targetConfigSchema<T extends TargetType>(type: T): (typeof CONFIG_SCHEMAS)[T] {
  return CONFIG_SCHEMAS[type];
}

export function createTargetVariant<T extends TargetType>(type: T) {
  return z.object({
    name: z.string().min(1, "Name is required"),
    type: z.literal(type),
    config: targetConfigSchema(type),
    isDefault: z.boolean().default(false),
  });
}

export const createTargetSchema = z.discriminatedUnion("type", [
  createTargetVariant("s3"),
  createTargetVariant("r2"),
  createTargetVariant("b2"),
  createTargetVariant("ssh"),
  createTargetVariant("local"),
]);

function mapSecrets<T extends object>(config: T, fn: (value: string) => string): T {
  const out = { ...config } as TargetConfig;
  for (const key of TARGET_SECRET_KEYS) {
    const value = out[key];
    if (typeof value === "string" && value !== "") out[key] = fn(value);
  }
  return out as T;
}

/** Encrypt the credential fields that aren't already ciphertext. */
export function sealTargetConfig<T extends object>(config: T, organizationId: string | null): T {
  return mapSecrets(config, (value) => {
    if (isEncrypted(value)) return value;
    return organizationId ? encrypt(value, organizationId) : encryptSystem(value);
  });
}

function openSecret(value: string, organizationId: string | null) {
  return organizationId ? decryptOrFallback(value, organizationId) : decryptSystemOrFallback(value);
}

export class TargetDecryptError extends Error {
  constructor(targetName: string) {
    super(
      `Credentials for backup target "${targetName}" cannot be decrypted with the running ENCRYPTION_MASTER_KEY`,
    );
    this.name = "TargetDecryptError";
  }
}

/** Plaintext config for the backup engine. Throws when a credential won't decrypt. */
export function openTargetConfig(target: {
  name?: string;
  organizationId?: string | null;
  config: unknown;
}): TargetConfig {
  const orgId = target.organizationId ?? null;
  return mapSecrets(target.config as TargetConfig, (value) => {
    const result = openSecret(value, orgId);
    if (result.decryptFailed) throw new TargetDecryptError(target.name ?? "unnamed");
    return result.content;
  });
}

/** Credential fields replaced with the mask sentinel, for API responses. */
export function maskTargetConfig(config: unknown): TargetConfig {
  const out: TargetConfig = { ...(config as TargetConfig) };
  for (const key of TARGET_SECRET_KEYS) {
    if (out[key] == null || out[key] === "") continue;
    out[key] = MASK_SENTINEL;
  }
  return out;
}

/** A target row safe to return to any caller. */
export function presentTarget<T extends { config: unknown }>(target: T): T {
  return { ...target, config: maskTargetConfig(target.config) };
}

/**
 * Apply an edit to a stored config. Non-credential fields are replaced
 * wholesale; a credential that's absent or masked keeps the stored value and
 * null clears it.
 */
export function mergeTargetConfig(stored: TargetConfig, incoming: TargetConfig): TargetConfig {
  const merged: TargetConfig = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!isSecretKey(key)) merged[key] = value;
  }
  for (const key of TARGET_SECRET_KEYS) {
    const value = incoming[key];
    if (value === null) continue;
    if (value === undefined || isMasked(value as string)) {
      if (stored[key] !== undefined) merged[key] = stored[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/** Credential fields still stored as plaintext. */
export function plaintextSecretKeys(config: unknown): string[] {
  const c = (config ?? {}) as TargetConfig;
  return TARGET_SECRET_KEYS.filter(
    (key) => typeof c[key] === "string" && c[key] !== "" && !isEncrypted(c[key] as string),
  );
}

/** Ciphertext credential fields, with whether the running key opens each. */
export function probeTargetSecrets(target: {
  organizationId: string | null;
  config: unknown;
}): { encrypted: number; undecryptable: number } {
  const c = (target.config ?? {}) as TargetConfig;
  let encrypted = 0;
  let undecryptable = 0;
  for (const key of TARGET_SECRET_KEYS) {
    const value = c[key];
    if (typeof value !== "string" || !isEncrypted(value)) continue;
    encrypted++;
    if (openSecret(value, target.organizationId).decryptFailed) undecryptable++;
  }
  return { encrypted, undecryptable };
}
