// The age identity every archive is encrypted to, derived from ENCRYPTION_MASTER_KEY.
// Node built-ins only, so the `vardo backup key` script runs without installed packages.

import { hkdfSync } from "crypto";
import { normalizeMasterKey } from "../crypto/key-fingerprint";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** BIP-173 checksum polynomial over 5-bit values. */
function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk >>> 0;
}

/** Bech32 string for `data`, in the lowercase form age's identities use before upper-casing. */
function bech32Encode(hrp: string, data: Uint8Array): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);

  const hrpValues = [...hrp].flatMap((c) => [c.charCodeAt(0) >>> 5]).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...hrpValues, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** The age secret key (`AGE-SECRET-KEY-1...`) for a master key. Anyone holding it can read the archives; it can't recover the master key. */
export function deriveArchiveIdentity(masterKey: string): string {
  const scalar = new Uint8Array(
    hkdfSync("sha256", normalizeMasterKey(masterKey), "vardo-backup-age/v1", "x25519-identity", 32),
  );
  return bech32Encode("age-secret-key-", scalar).toUpperCase();
}
