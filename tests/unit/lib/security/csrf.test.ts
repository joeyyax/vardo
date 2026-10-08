// Session cookies are SameSite=Lax, which still rides along on POSTs from any
// same-site origin — including every app Vardo hosts on a sibling subdomain.
// Unsafe cookie-authenticated API requests must come from Vardo itself.

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { csrfRejection } from "@/lib/security/csrf";
import { proxy } from "@/proxy";

vi.mock("@/lib/security/proxy-credentials", () => ({ hasValidCredentials: async () => false }));

const ENV = { NEXT_PUBLIC_APP_URL: "https://vardo.example.com" } as unknown as NodeJS.ProcessEnv;
const COOKIE = "__Secure-better-auth.session_token=abc; theme=dark";

function check(headers: Record<string, string>, opts: { method?: string; path?: string; env?: NodeJS.ProcessEnv } = {}) {
  const h = new Headers({ host: "vardo.example.com", ...headers });
  return csrfRejection(
    { method: opts.method ?? "POST", pathname: opts.path ?? "/api/v1/organizations/o/apps", headers: h },
    opts.env ?? ENV,
  );
}

describe("csrfRejection", () => {
  it("blocks a cookie POST from a sibling app on the same site", () => {
    expect(
      check({ cookie: COOKIE, origin: "https://evil.example.com", "sec-fetch-site": "same-site" }),
    ).toMatch(/evil\.yax\.me/);
  });

  it("blocks a cross-site cookie POST that sends no Origin", () => {
    expect(check({ cookie: COOKIE, "sec-fetch-site": "cross-site" })).toMatch(/cross-site/);
  });

  it("blocks a mismatched Origin from a browser without Sec-Fetch-Site", () => {
    expect(check({ cookie: COOKIE, origin: "https://attacker.example" })).not.toBeNull();
  });

  it("allows the dashboard's own requests", () => {
    expect(check({ cookie: COOKIE, origin: "https://vardo.example.com", "sec-fetch-site": "same-origin" })).toBeNull();
    expect(check({ cookie: COOKIE, origin: "https://vardo.example.com" })).toBeNull();
  });

  it("allows an Origin matching the forwarded host or the configured URL", () => {
    expect(
      check({ cookie: COOKIE, host: "vardo:3000", "x-forwarded-host": "vardo.example.com", origin: "https://vardo.example.com" }),
    ).toBeNull();
    expect(check({ cookie: COOKIE, host: "vardo:3000", origin: "https://vardo.example.com" })).toBeNull();
  });

  it("allows origins listed in VARDO_TRUSTED_ORIGINS", () => {
    const env = { ...ENV, VARDO_TRUSTED_ORIGINS: "https://10.0.0.19:3000" } as unknown as NodeJS.ProcessEnv;
    expect(check({ cookie: COOKIE, origin: "https://10.0.0.19:3000" }, { env })).toBeNull();
  });

  it("never blocks bearer, cookieless, safe-method or Better Auth requests", () => {
    const cross = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    expect(check({ ...cross, cookie: COOKIE, authorization: "Bearer vardo_x" })).toBeNull();
    expect(check({ ...cross, cookie: "theme=dark" })).toBeNull();
    expect(check({ ...cross, cookie: COOKIE }, { method: "GET" })).toBeNull();
    expect(check({ ...cross, cookie: COOKIE }, { path: "/api/auth/sign-in/email" })).toBeNull();
  });

  it("can be switched off", () => {
    const env = { ...ENV, VARDO_CSRF_CHECK: "off" } as unknown as NodeJS.ProcessEnv;
    expect(check({ cookie: COOKIE, origin: "https://evil.example.com" }, { env })).toBeNull();
  });
});

describe("proxy", () => {
  it("returns 403 for a cross-site cookie POST to the API", async () => {
    const req = new NextRequest("https://vardo.example.com/api/v1/organizations/o/apps", {
      method: "POST",
      headers: { cookie: COOKIE, origin: "https://evil.example.com", "sec-fetch-site": "same-site" },
    });
    expect((await proxy(req)).status).toBe(403);
  });

  it("passes the dashboard's own POST", async () => {
    const req = new NextRequest("https://vardo.example.com/api/v1/organizations/o/apps", {
      method: "POST",
      headers: { cookie: COOKIE, origin: "https://vardo.example.com", "sec-fetch-site": "same-origin" },
    });
    expect((await proxy(req)).status).toBe(200);
  });
});
