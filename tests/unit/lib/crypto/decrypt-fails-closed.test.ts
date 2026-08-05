import { describe, it, expect } from "vitest";

// Set before the module loads — the key is read at import time.
process.env.ENCRYPTION_MASTER_KEY ??= "0".repeat(64);

const { decryptOrFallback, encrypt } = await import("@/lib/crypto/encrypt");

// ---------------------------------------------------------------------------
// The three states decryptOrFallback reports, and why the third has to abort
// whatever was about to use the result.
//
// A failed decrypt returns empty content with wasEncrypted = true. Code shaped
// as `if (content) {...} else if (!wasEncrypted) {warn}` takes neither branch,
// so the caller proceeds with nothing and says nothing.
// ---------------------------------------------------------------------------

const ORG = "org-test";

describe("decryptOrFallback", () => {
  it("passes plaintext through as unencrypted", () => {
    const result = decryptOrFallback("PLAIN=1", ORG);
    expect(result).toMatchObject({ content: "PLAIN=1", wasEncrypted: false });
    expect(result.decryptFailed).toBeFalsy();
  });

  it("round-trips a value encrypted for the same org", () => {
    const result = decryptOrFallback(encrypt("SECRET=1", ORG), ORG);
    expect(result).toMatchObject({ content: "SECRET=1", wasEncrypted: true });
    expect(result.decryptFailed).toBeFalsy();
  });

  it("reports a failure distinctly, rather than as empty plaintext", () => {
    const result = decryptOrFallback(encrypt("SECRET=1", ORG), "a-different-org");
    expect(result.decryptFailed).toBe(true);
    expect(result.content).toBe("");
    expect(result.wasEncrypted).toBe(true);
  });

  it("the failure state is invisible to a content-or-wasEncrypted check", () => {
    // This is the shape that shipped: neither branch fires, so a deploy
    // proceeded with an empty environment and logged nothing.
    const { content, wasEncrypted } = decryptOrFallback(encrypt("SECRET=1", ORG), "wrong-org");
    const tookContentBranch = Boolean(content);
    const tookWarningBranch = !wasEncrypted;
    expect(tookContentBranch).toBe(false);
    expect(tookWarningBranch).toBe(false);
  });

  it("an empty plaintext value is not a failure", () => {
    const result = decryptOrFallback("", ORG);
    expect(result.decryptFailed).toBeFalsy();
  });
});
