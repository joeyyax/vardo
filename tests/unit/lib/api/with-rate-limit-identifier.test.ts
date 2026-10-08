import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: vi.fn() }));
const { extractIdentifier } = await import("@/lib/api/with-rate-limit");

function req(cookie: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { cookie: `better-auth.session_token=${cookie}`, "x-forwarded-for": "203.0.113.7" },
  });
}

describe("extractIdentifier", () => {
  it("ignores session cookies on the auth tier, so rotating them doesn't reset the bucket", () => {
    expect(extractIdentifier(req("a"), "auth")).toBe("203.0.113.7");
    expect(extractIdentifier(req("b"), "auth")).toBe("203.0.113.7");
  });

  it("keys other tiers by session", () => {
    expect(extractIdentifier(req("a"), "mutation")).not.toBe(extractIdentifier(req("b"), "mutation"));
  });
});
