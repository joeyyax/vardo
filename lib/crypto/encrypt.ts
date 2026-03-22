import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let _masterKeyChecked = false;

/**
 * Check that the encryption master key is configured.
 * Call on startup to fail fast rather than at first encrypt/decrypt.
 */
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
  // Accept hex (64 chars) or base64 (44 chars) encoded 32-byte keys
  if (key.length === 64) return Buffer.from(key, "hex");
  if (key.length === 44) return Buffer.from(key, "base64");
  // Raw string — hash it to 32 bytes via HKDF
  return Buffer.from(hkdfSync("sha256", key, "", "master", 32));
}

function deriveOrgKey(orgId: string): Buffer {
  const master = getMasterKey();
  return Buffer.from(hkdfSync("sha256", master, orgId, "host-env-encryption", 32));
}

/**
 * Encrypt plaintext for a specific org.
 * Returns a string in the format: iv:ciphertext:authTag (all hex-encoded)
 */
export function encrypt(plaintext: string, orgId: string): string {
  const key = deriveOrgKey(orgId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${encrypted}:${tag}`;
}

/**
 * Decrypt a value encrypted with encrypt().
 * Input format: iv:ciphertext:authTag (all hex-encoded)
 */
export function decrypt(encrypted: string, orgId: string): string {
  const parts = encrypted.split(":");
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

/**
 * Check if a value looks like an encrypted blob (iv:ciphertext:tag format).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts[0].length === IV_LENGTH * 2;
}

/**
 * Try to decrypt, falling back to plaintext for unmigrated data.
 * Returns { content, encrypted } so callers know the state.
 */
export function decryptOrFallback(
  value: string,
  orgId: string
): { content: string; wasEncrypted: boolean } {
  if (!isEncrypted(value)) {
    // Plaintext — unmigrated data
    return { content: value, wasEncrypted: false };
  }

  try {
    return { content: decrypt(value, orgId), wasEncrypted: true };
  } catch {
    // Decryption failed — wrong key or corrupted data
    // Return empty rather than exposing garbage
    console.error(`[crypto] Decryption failed for org ${orgId} — wrong key or corrupted data`);
    return { content: "", wasEncrypted: false };
  }
}

// ---------------------------------------------------------------------------
// System-level encryption (not org-scoped)
// Used for systemSettings rows that contain secrets (backup creds, GitHub
// App private key, email API tokens). Uses a fixed "system" scope so that
// the derived key is deterministic but separate from all org keys.
// ---------------------------------------------------------------------------

const SYSTEM_SCOPE = "host-system-settings";

function deriveSystemKey(): Buffer {
  const master = getMasterKey();
  return Buffer.from(hkdfSync("sha256", master, SYSTEM_SCOPE, "host-system-encryption", 32));
}

/**
 * Encrypt a plaintext string at the system level (not org-scoped).
 * Returns iv:ciphertext:authTag (hex-encoded), same format as encrypt().
 */
export function encryptSystem(plaintext: string): string {
  const key = deriveSystemKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${encrypted}:${tag}`;
}

/**
 * Decrypt a value encrypted with encryptSystem().
 */
export function decryptSystem(encrypted: string): string {
  const parts = encrypted.split(":");
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

/**
 * Try to decrypt a system setting, falling back to plaintext for
 * rows written before encryption was added.
 */
export function decryptSystemOrFallback(value: string): { content: string; wasEncrypted: boolean } {
  if (!isEncrypted(value)) {
    return { content: value, wasEncrypted: false };
  }

  try {
    return { content: decryptSystem(value), wasEncrypted: true };
  } catch {
    console.error("[crypto] System setting decryption failed — wrong key or corrupted data");
    return { content: "", wasEncrypted: false };
  }
}
