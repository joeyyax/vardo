import { describe, it, expect } from "vitest";
import { checkRestoreKey, holdsInstanceSecrets } from "@/lib/backups/key-guard";

// ---------------------------------------------------------------------------
// Restoring Vardo's own database dump onto a host with a different master key
// produces a complete database whose every env var is unreadable. The gate has
// to fire there and nowhere else — an app's own dump has no relationship to the
// master key, and blocking those would make the guard something to work around.
// ---------------------------------------------------------------------------

const MINE = "k1:0123456789abcdef";
const THEIRS = "k1:fedcba9876543210";

describe("holdsInstanceSecrets", () => {
  it("is true for the system postgres volume", () => {
    expect(holdsInstanceSecrets({ appId: null, name: "postgres" })).toBe(true);
  });

  it("is false for an app's own postgres volume", () => {
    expect(holdsInstanceSecrets({ appId: "app-1", name: "postgres" })).toBe(false);
  });

  it("is false for another system volume", () => {
    expect(holdsInstanceSecrets({ appId: null, name: "redis" })).toBe(false);
  });

  it("is false when the volume name was never recorded", () => {
    expect(holdsInstanceSecrets({ appId: null, name: null })).toBe(false);
  });
});

describe("checkRestoreKey", () => {
  it("lets an app archive through regardless of the keys", () => {
    expect(
      checkRestoreKey({
        archiveFingerprint: THEIRS,
        runningFingerprint: MINE,
        holdsInstanceSecrets: false,
      }),
    ).toEqual({ kind: "proceed" });
  });

  it("lets an instance archive through when the keys agree", () => {
    expect(
      checkRestoreKey({
        archiveFingerprint: MINE,
        runningFingerprint: MINE,
        holdsInstanceSecrets: true,
      }),
    ).toEqual({ kind: "proceed" });
  });

  it("blocks an instance archive written with a different key", () => {
    const verdict = checkRestoreKey({
      archiveFingerprint: THEIRS,
      runningFingerprint: MINE,
      holdsInstanceSecrets: true,
    });
    expect(verdict.kind).toBe("blocked");
    expect(verdict.kind === "blocked" && verdict.message).toContain(THEIRS);
    expect(verdict.kind === "blocked" && verdict.message).toContain(MINE);
  });

  it("blocks an instance archive when no key is configured", () => {
    expect(
      checkRestoreKey({
        archiveFingerprint: THEIRS,
        runningFingerprint: null,
        holdsInstanceSecrets: true,
      }).kind,
    ).toBe("blocked");
  });

  it("does not block an archive predating fingerprinting, but says so", () => {
    const verdict = checkRestoreKey({
      archiveFingerprint: null,
      runningFingerprint: MINE,
      holdsInstanceSecrets: true,
    });
    expect(verdict.kind).toBe("unverifiable");
  });

  it("says nothing about an app archive predating fingerprinting", () => {
    expect(
      checkRestoreKey({
        archiveFingerprint: null,
        runningFingerprint: MINE,
        holdsInstanceSecrets: false,
      }),
    ).toEqual({ kind: "proceed" });
  });
});
