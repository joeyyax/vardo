import { describe, it, expect } from "vitest";
import { hkdfSync } from "crypto";
import {
  evaluateKeyFingerprint,
  fingerprintMasterKey,
  isKeyFingerprint,
  normalizeMasterKey,
} from "@/lib/crypto/key-fingerprint";

// ---------------------------------------------------------------------------
// The fingerprint identifies which key a body of ciphertext belongs to. It
// travels with backups and shows in the UI, so it has to be one-way, stable,
// and unequal for unequal keys.
// ---------------------------------------------------------------------------

const HEX_KEY = "a".repeat(64);
const OTHER_HEX_KEY = "b".repeat(64);

describe("normalizeMasterKey", () => {
  it("decodes a 64-char hex key to its 32 bytes", () => {
    expect(normalizeMasterKey(HEX_KEY)).toEqual(Buffer.from(HEX_KEY, "hex"));
  });

  it("decodes a 44-char base64 key to its 32 bytes", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(key.length).toBe(44);
    expect(normalizeMasterKey(key)).toEqual(Buffer.alloc(32, 7));
  });

  it("derives a raw string through HKDF with an empty salt", () => {
    // Pinned, not recomputed from the implementation: changing this derivation
    // orphans every value encrypted by an instance using a raw-string key.
    expect(normalizeMasterKey("passphrase")).toEqual(
      Buffer.from(hkdfSync("sha256", "passphrase", "", "master", 32)),
    );
  });
});

describe("fingerprintMasterKey", () => {
  it("is stable for one key", () => {
    expect(fingerprintMasterKey(HEX_KEY)).toBe(fingerprintMasterKey(HEX_KEY));
  });

  it("differs for different keys", () => {
    expect(fingerprintMasterKey(HEX_KEY)).not.toBe(fingerprintMasterKey(OTHER_HEX_KEY));
  });

  it("agrees across encodings of the same 32 bytes", () => {
    const bytes = Buffer.alloc(32, 3);
    expect(fingerprintMasterKey(bytes.toString("hex"))).toBe(
      fingerprintMasterKey(bytes.toString("base64")),
    );
  });

  it("contains no material from the key", () => {
    const fingerprint = fingerprintMasterKey(HEX_KEY);
    expect(fingerprint).not.toContain(HEX_KEY);
    expect(fingerprint.slice(3)).not.toContain(HEX_KEY.slice(0, 8));
  });

  it("produces the shape isKeyFingerprint recognises", () => {
    expect(isKeyFingerprint(fingerprintMasterKey(HEX_KEY))).toBe(true);
    expect(fingerprintMasterKey(HEX_KEY)).toMatch(/^k1:[0-9a-f]{16}$/);
  });
});

describe("isKeyFingerprint", () => {
  it("rejects anything that is not a versioned digest", () => {
    for (const value of ["", "k1:", "k1:zzzz", "k2:0123456789abcdef", "0123456789abcdef"]) {
      expect(isKeyFingerprint(value)).toBe(false);
    }
  });

  it("rejects an encrypted blob", () => {
    expect(isKeyFingerprint("enc:v1:aabb:ccdd:eeff")).toBe(false);
  });
});

describe("evaluateKeyFingerprint", () => {
  it("reports no key at all before anything else", () => {
    expect(evaluateKeyFingerprint("k1:0123456789abcdef", null)).toEqual({ kind: "unconfigured" });
  });

  it("reports nothing on file as unrecorded", () => {
    expect(evaluateKeyFingerprint(null, "k1:0123456789abcdef")).toEqual({
      kind: "unrecorded",
      running: "k1:0123456789abcdef",
    });
  });

  it("reports a match", () => {
    expect(evaluateKeyFingerprint("k1:0123456789abcdef", "k1:0123456789abcdef")).toEqual({
      kind: "ok",
      fingerprint: "k1:0123456789abcdef",
    });
  });

  it("reports the restored-onto-a-new-host case as a mismatch", () => {
    expect(evaluateKeyFingerprint("k1:0123456789abcdef", "k1:fedcba9876543210")).toEqual({
      kind: "mismatch",
      recorded: "k1:0123456789abcdef",
      running: "k1:fedcba9876543210",
    });
  });
});
