// One-way fingerprint of ENCRYPTION_MASTER_KEY. Safe to store and display.

import { hkdfSync } from "crypto";

/** Version marker. Bump alongside any change to the derivation below. */
const FINGERPRINT_VERSION = "k1";

/** Hex characters kept from the derived digest. */
const FINGERPRINT_HEX_CHARS = 16;

/**
 * Turns a configured key string into the 32 bytes every derivation starts from.
 * Don't change the empty salt on the raw-string path; it orphans existing ciphertext.
 */
export function normalizeMasterKey(key: string): Buffer {
  if (key.length === 64) return Buffer.from(key, "hex");
  if (key.length === 44) return Buffer.from(key, "base64");
  return Buffer.from(hkdfSync("sha256", key, "", "master", 32));
}

/** Fingerprint of a configured master key, as `k1:` followed by 16 hex chars. */
export function fingerprintMasterKey(key: string): string {
  const digest = Buffer.from(
    hkdfSync("sha256", normalizeMasterKey(key), "vardo-key-fingerprint/v1", "fingerprint", 32),
  ).toString("hex");
  return `${FINGERPRINT_VERSION}:${digest.slice(0, FINGERPRINT_HEX_CHARS)}`;
}

/** Whether a string has the shape this module produces. */
export function isKeyFingerprint(value: string): boolean {
  return new RegExp(`^${FINGERPRINT_VERSION}:[0-9a-f]{${FINGERPRINT_HEX_CHARS}}$`).test(value);
}

export type KeyFingerprintStatus =
  /** The running key is the one this database's ciphertext was written with. */
  | { kind: "ok"; fingerprint: string }
  /** No ENCRYPTION_MASTER_KEY is set. */
  | { kind: "unconfigured" }
  /** Nothing recorded yet. */
  | { kind: "unrecorded"; running: string }
  /** The running key cannot decrypt anything this database holds. */
  | { kind: "mismatch"; recorded: string; running: string };

/** Compares the fingerprint a database recorded against the running key's. */
export function evaluateKeyFingerprint(
  recorded: string | null,
  running: string | null,
): KeyFingerprintStatus {
  if (!running) return { kind: "unconfigured" };
  if (!recorded) return { kind: "unrecorded", running };
  if (recorded !== running) return { kind: "mismatch", recorded, running };
  return { kind: "ok", fingerprint: running };
}
