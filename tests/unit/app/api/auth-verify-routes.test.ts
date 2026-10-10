import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const authGet = vi.hoisted(() => vi.fn());
const authPost = vi.hoisted(() => vi.fn());
const methodEnabled = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: {}, ensureGitHubCredentials: async () => {} }));
vi.mock("better-auth/next-js", () => ({ toNextJsHandler: () => ({ GET: authGet, POST: authPost }) }));
vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (fn: unknown) => fn }));
vi.mock("@/lib/config/provider-restrictions", () => ({ isPasswordAuthAllowed: () => true }));
vi.mock("@/lib/config/auth-methods", () => ({
  isAuthMethodEnabledAsync: methodEnabled,
  getAuthMethodConfig: (m: string) => ({ label: m }),
}));

const { GET, POST } = await import("@/app/api/auth/[...all]/route");

beforeEach(() => {
  authGet.mockReset().mockResolvedValue(new Response(null, { status: 302 }));
  authPost.mockReset().mockResolvedValue(Response.json({ status: true }));
  methodEnabled.mockReset().mockResolvedValue(false);
});

describe("auth route", () => {
  it("reaches verify-email with every sign-in method off", async () => {
    const res = await (GET as (r: NextRequest) => Promise<Response>)(
      new NextRequest("https://host.example.com/api/auth/verify-email?token=t&callbackURL=%2Fuser%2Fsettings%2Fprofile%3FemailVerified%3D1"),
    );
    expect(res.status).toBe(302);
    expect(authGet).toHaveBeenCalledOnce();
  });

  it.each(["send-verification-email", "change-email"])("reaches %s regardless of sign-in methods", async (path) => {
    const res = await (POST as (r: NextRequest) => Promise<Response>)(
      new NextRequest(`https://host.example.com/api/auth/${path}`, { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
    expect(authPost).toHaveBeenCalledOnce();
  });
});
