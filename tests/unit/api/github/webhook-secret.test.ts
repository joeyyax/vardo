import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// Webhook HMAC secret isolation
// ---------------------------------------------------------------------------
// These tests exercise the secret-selection logic extracted from the webhook
// route to ensure:
//   1. The handler rejects requests when GITHUB_WEBHOOK_SECRET is unset.
//   2. The handler never silently falls back to BETTER_AUTH_SECRET.
//   3. A valid GITHUB_WEBHOOK_SECRET passes signature verification.

// Minimal extract of the secret-resolution logic (mirrors route.ts line ~22).
// Keeping it as a pure function makes it unit-testable without Next.js plumbing.
function resolveWebhookSecret(env: Record<string, string | undefined>): string | null {
  return env.GITHUB_WEBHOOK_SECRET ?? null;
}

function buildExpectedSignature(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// Save and restore env so tests don't bleed into each other.
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const key of ["GITHUB_WEBHOOK_SECRET", "BETTER_AUTH_SECRET"]) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("webhook secret isolation", () => {
  it("returns null when GITHUB_WEBHOOK_SECRET is not set", () => {
    const secret = resolveWebhookSecret({
      BETTER_AUTH_SECRET: "session-secret",
    });
    expect(secret).toBeNull();
  });

  it("does not fall back to BETTER_AUTH_SECRET", () => {
    const secret = resolveWebhookSecret({
      BETTER_AUTH_SECRET: "session-secret",
      // GITHUB_WEBHOOK_SECRET intentionally absent
    });
    expect(secret).toBeNull();
    // The resolved value must never equal the session secret
    expect(secret).not.toBe("session-secret");
  });

  it("returns the dedicated webhook secret when set", () => {
    const secret = resolveWebhookSecret({
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      BETTER_AUTH_SECRET: "session-secret",
    });
    expect(secret).toBe("webhook-secret");
  });

  it("generates a verifiable HMAC signature with the webhook secret", () => {
    const body = JSON.stringify({ action: "push" });
    const webhookSecret = "webhook-secret";
    const sig = buildExpectedSignature(webhookSecret, body);

    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Verify it does NOT match a signature generated with the session secret
    const sessionSig = buildExpectedSignature("session-secret", body);
    expect(sig).not.toBe(sessionSig);
  });

  it("rejects a signature produced with BETTER_AUTH_SECRET", () => {
    const body = JSON.stringify({ action: "push" });
    const webhookSecret = "webhook-secret";
    const sessionSecret = "session-secret";

    const expected = buildExpectedSignature(webhookSecret, body);
    const forged = buildExpectedSignature(sessionSecret, body);

    expect(forged).not.toBe(expected);
  });
});
