import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Prefix that marks an encrypted blob. All values produced by encrypt() and
 * encryptSystem() start with this string, making detection unambiguous and
 * immune to false-positives on plaintext that happens to contain two colons.
 */
export const ENCRYPTED_PREFIX = "enc:v1:";

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
  // Raw string — hash it to 32 bytes via HKDF.
  // Salt is kept as "" (empty) to preserve backward compatibility with any
  // existing deployments using a raw-string master key. Changing this salt
  // would silently derive a different key and break all previously encrypted
  // data. Hex/base64 keys (the recommended path) bypass HKDF entirely.
  return Buffer.from(hkdfSync("sha256", key, "", "master", 32));
}

function deriveOrgKey(orgId: string): Buffer {
  const master = getMasterKey();
  return Buffer.from(hkdfSync("sha256", master, orgId, "host-env-encryption", 32));
}

/**
 * Encrypt plaintext for a specific org.
 * Returns a string in the format: enc:v1:iv:ciphertext:authTag (all hex-encoded)
 */
export function encrypt(plaintext: string, orgId: string): string {
  const key = deriveOrgKey(orgId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${encrypted}:${tag}`;
}

/**
 * Decrypt a value encrypted with encrypt().
 * Accepts both the current enc:v1:iv:ciphertext:tag format and the legacy
 * iv:ciphertext:tag format (for rows encrypted before the prefix was added).
 */
export function decrypt(encrypted: string, orgId: string): string {
  // Strip prefix if present
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

/**
 * Check if a value is an encrypted blob.
 * The canonical format is enc:v1:iv:ciphertext:authTag. The legacy format
 * (iv:ciphertext:authTag with no prefix) is also recognised for rows written
 * before the prefix was introduced, but is increasingly unlikely to match
 * plaintext by accident.
 */
export function isEncrypted(value: string): boolean {
  if (value.startsWith(ENCRYPTED_PREFIX)) {
    // Current format — unambiguous
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
  // Legacy format — stricter validation to reduce false-positives
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

/**
 * Try to decrypt, falling back to plaintext for unmigrated data.
 * Returns { content, wasEncrypted, decryptFailed } so callers can distinguish:
 *   - wasEncrypted=false, decryptFailed=false → plaintext (unmigrated row)
 *   - wasEncrypted=true,  decryptFailed=false → successfully decrypted
 *   - wasEncrypted=true,  decryptFailed=true  → recognised as encrypted but
 *     decryption failed (wrong key / corrupted data); content is empty
 */
export function decryptOrFallback(
  value: string,
  orgId: string
): { content: string; wasEncrypted: boolean; decryptFailed?: boolean } {
  if (!isEncrypted(value)) {
    // Plaintext — unmigrated data
    return { content: value, wasEncrypted: false };
  }

  try {
    return { content: decrypt(value, orgId), wasEncrypted: true };
  } catch {
    // Decryption failed — wrong key or corrupted data
    console.error(`[crypto] Decryption failed for org ${orgId} — wrong key or corrupted data`);
    return { content: "", wasEncrypted: true, decryptFailed: true };
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
 * Returns enc:v1:iv:ciphertext:authTag (hex-encoded), same format as encrypt().
 */
export function encryptSystem(plaintext: string): string {
  const key = deriveSystemKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${encrypted}:${tag}`;
}

/**
 * Decrypt a value encrypted with encryptSystem().
 * Accepts both the current enc:v1:iv:ciphertext:tag format and the legacy
 * iv:ciphertext:tag format (for rows encrypted before the prefix was added).
 */
export function decryptSystem(encrypted: string): string {
  // Strip prefix if present
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

/**
 * Try to decrypt a system setting, falling back to plaintext for
 * rows written before encryption was added.
 * Returns { content, wasEncrypted, decryptFailed } so callers can distinguish:
 *   - wasEncrypted=false, decryptFailed=false → plaintext (unmigrated row)
 *   - wasEncrypted=true,  decryptFailed=false → successfully decrypted
 *   - wasEncrypted=true,  decryptFailed=true  → recognised as encrypted but
 *     decryption failed (wrong key / corrupted data); content is empty
 */
export function decryptSystemOrFallback(value: string): { content: string; wasEncrypted: boolean; decryptFailed?: boolean } {
  if (!isEncrypted(value)) {
    return { content: value, wasEncrypted: false };
  }

  try {
    return { content: decryptSystem(value), wasEncrypted: true };
  } catch {
    console.error("[crypto] System setting decryption failed — wrong key or corrupted data");
    return { content: "", wasEncrypted: true, decryptFailed: true };
  }
}
