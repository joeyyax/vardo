import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "crypto";
import { fingerprintMasterKey, normalizeMasterKey } from "./key-fingerprint";
import { logger } from "@/lib/logger";

const log = logger.child("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Prefix on every value from encrypt() and encryptSystem(). */
export const ENCRYPTED_PREFIX = "enc:v1:";

let _masterKeyChecked = false;

/** Checks that the encryption master key is configured. Call on startup. */
export function checkEncryptionKey(): { ok: boolean; error?: string } {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  if (!key) {
    return { ok: false, error: "ENCRYPTION_MASTER_KEY environment variable is not set. Env var encryption is disabled." };
  }
  _masterKeyChecked = true;
  return { ok: true };
}

function getMasterKey(): Buffer {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  if (!key) {
    throw new Error(
      "ENCRYPTION_MASTER_KEY is not set. Cannot encrypt/decrypt env vars. " +
      "Generate one with: openssl rand -hex 32"
    );
  }
  return normalizeMasterKey(key);
}

/** Fingerprint of the running master key, or null when none is configured. */
export function runningKeyFingerprint(): string | null {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  return key ? fingerprintMasterKey(key) : null;
}

function deriveOrgKey(orgId: string): Buffer {
  const master = getMasterKey();
  return Buffer.from(hkdfSync("sha256", master, orgId, "host-env-encryption", 32));
}

/** Encrypts plaintext for an org as enc:v1:iv:ciphertext:authTag (hex). */
export function encrypt(plaintext: string, orgId: string): string {
  const key = deriveOrgKey(orgId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${encrypted}:${tag}`;
}

/** Decrypts a value from encrypt(). Accepts the legacy unprefixed iv:ciphertext:tag format. */
export function decrypt(encrypted: string, orgId: string): string {
  const payload = encrypted.startsWith(ENCRYPTED_PREFIX)
    ? encrypted.slice(ENCRYPTED_PREFIX.length)
    : encrypted;

  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted value format — expected iv:ciphertext:tag");
  }

  const [ivHex, ciphertext, tagHex] = parts;
  const key = deriveOrgKey(orgId);
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/** Whether a value is an encrypted blob, prefixed or legacy unprefixed. */
export function isEncrypted(value: string): boolean {
  if (value.startsWith(ENCRYPTED_PREFIX)) {
    const payload = value.slice(ENCRYPTED_PREFIX.length);
    const parts = payload.split(":");
    if (parts.length !== 3) return false;
    const [ivHex, , tagHex] = parts;
    return (
      ivHex.length === IV_LENGTH * 2 &&
      tagHex.length === TAG_LENGTH * 2 &&
      /^[0-9a-f]+$/i.test(ivHex) &&
      /^[0-9a-f]+$/i.test(tagHex)
    );
  }
  // Legacy format: stricter validation to avoid matching plaintext.
  const parts = value.split(":");
  if (parts.length !== 3) return false;
  const [ivHex, cipherHex, tagHex] = parts;
  return (
    ivHex.length === IV_LENGTH * 2 &&
    tagHex.length === TAG_LENGTH * 2 &&
    /^[0-9a-f]+$/i.test(ivHex) &&
    cipherHex.length > 0 &&
    /^[0-9a-f]+$/i.test(cipherHex) &&
    /^[0-9a-f]+$/i.test(tagHex)
  );
}

/** Decrypts, or returns plaintext as-is. On a failed decrypt, content is empty and decryptFailed is set. */
export function decryptOrFallback(
  value: string,
  orgId: string
): { content: string; wasEncrypted: boolean; decryptFailed?: boolean } {
  if (!isEncrypted(value)) {
    return { content: value, wasEncrypted: false };
  }

  try {
    return { content: decrypt(value, orgId), wasEncrypted: true };
  } catch {
    log.error(`Decryption failed for org ${orgId} — wrong key or corrupted data`);
    return { content: "", wasEncrypted: true, decryptFailed: true };
  }
}

// System-level encryption for secrets in systemSettings, keyed separately from every org.

const SYSTEM_SCOPE = "host-system-settings";

function deriveSystemKey(): Buffer {
  const master = getMasterKey();
  return Buffer.from(hkdfSync("sha256", master, SYSTEM_SCOPE, "host-system-encryption", 32));
}

/** Encrypts plaintext with the system key, in the same format as encrypt(). */
export function encryptSystem(plaintext: string): string {
  const key = deriveSystemKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${encrypted}:${tag}`;
}

/** Decrypts a value from encryptSystem(). Accepts the legacy unprefixed format. */
export function decryptSystem(encrypted: string): string {
  const payload = encrypted.startsWith(ENCRYPTED_PREFIX)
    ? encrypted.slice(ENCRYPTED_PREFIX.length)
    : encrypted;

  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted value format — expected iv:ciphertext:tag");
  }

  const [ivHex, ciphertext, tagHex] = parts;
  const key = deriveSystemKey();
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/** System-key decryptOrFallback(). */
export function decryptSystemOrFallback(value: string): { content: string; wasEncrypted: boolean; decryptFailed?: boolean } {
  if (!isEncrypted(value)) {
    return { content: value, wasEncrypted: false };
  }

  try {
    return { content: decryptSystem(value), wasEncrypted: true };
  } catch {
    log.error("System setting decryption failed — wrong key or corrupted data");
    return { content: "", wasEncrypted: true, decryptFailed: true };
  }
}
