import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getMasterKey(): Buffer {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_MASTER_KEY environment variable is required");
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
    throw new Error("Invalid encrypted value format");
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
