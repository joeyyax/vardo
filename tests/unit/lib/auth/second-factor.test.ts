// A user with two-factor on is challenged after a magic link, not signed straight in.

import { describe, it, expect } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink, twoFactor } from "better-auth/plugins";

import { ACCOUNT_LINKING, needsSecondFactorHook, returnPath, secondFactorEverywhere } from "@/lib/auth/second-factor";

const BASE = "http://localhost:3000";

function setup() {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [], session: [], account: [], verification: [], twoFactor: [],
  };
  let link = "";
  const auth = betterAuth({
    baseURL: BASE,
    secret: "test-secret-test-secret-test-secret-0123",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [
      twoFactor({ issuer: "Test" }),
      secondFactorEverywhere(),
      magicLink({ sendMagicLink: async ({ url }) => { link = url; } }),
    ],
  });
  return { auth, db, link: () => link };
}

async function signInByLink(env: ReturnType<typeof setup>, email: string) {
  await env.auth.api.signInMagicLink({ body: { email, callbackURL: "/projects" }, headers: new Headers() });
  return env.auth.handler(new Request(env.link()));
}

const cookies = (res: Response) => res.headers.getSetCookie().join("\n");

describe("second factor on magic-link sign-in", () => {
  it("signs a user without two-factor straight in", async () => {
    const env = setup();
    await env.auth.api.signUpEmail({ body: { email: "a@example.com", password: "password123", name: "A" } });

    const res = await signInByLink(env, "a@example.com");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/projects");
    expect(cookies(res)).toMatch(/session_token=[^;]+;/);
  });

  it("sends a user with two-factor to the challenge with no session", async () => {
    const env = setup();
    await env.auth.api.signUpEmail({ body: { email: "b@example.com", password: "password123", name: "B" } });
    env.db.user[0].twoFactorEnabled = true;
    const before = env.db.session.map((r) => r.token);

    const res = await signInByLink(env, "b@example.com");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE}/login/2fa?callbackUrl=${encodeURIComponent("/projects")}`);
    expect(cookies(res)).toContain("two_factor=");
    expect(env.db.session.every((r) => before.includes(r.token))).toBe(true);
    const sessionCookies = res.headers.getSetCookie().filter((c) => c.includes("session_token="));
    expect(sessionCookies.at(-1)).toMatch(/Max-Age=0/i);
  });
});

describe("helpers", () => {
  it("trusts no provider's email for account linking", () => {
    expect(ACCOUNT_LINKING.trustedProviders).not.toContain("github");
  });

  it("matches the sign-in endpoints the twoFactor plugin misses", () => {
    expect(needsSecondFactorHook("/magic-link/verify")).toBe(true);
    expect(needsSecondFactorHook("/callback/:id")).toBe(true);
    expect(needsSecondFactorHook("/sign-in/email")).toBe(false);
  });

  it("keeps the return path on this origin", () => {
    expect(returnPath("http://localhost:3000/apps?x=1", BASE)).toBe("/apps?x=1");
    expect(returnPath("/apps", BASE)).toBe("/apps");
    expect(returnPath("https://evil.example.com/", BASE)).toBe("/");
    expect(returnPath(null, BASE)).toBe("/");
  });
});
