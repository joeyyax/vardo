// The proxy's per-IP cap counts only requests without a session or token the server accepts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getSession = vi.fn();
const findApiToken = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/auth/api-token", () => ({ findApiToken }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: async () => true }));

import { proxy } from "@/proxy";
import { clearCredentialVerdicts } from "@/lib/security/proxy-credentials";

let n = 0;
function request(ip: string, headers: Record<string, string> = {}) {
  return new NextRequest("https://vardo.example.com/api/v1/organizations/o/apps", {
    headers: { "x-forwarded-for": ip, ...headers },
  });
}

async function burst(count: number, make: () => NextRequest) {
  let last = 200;
  for (let i = 0; i < count; i++) last = (await proxy(make())).status;
  return last;
}

beforeEach(() => {
  clearCredentialVerdicts();
  getSession.mockReset().mockResolvedValue(null);
  findApiToken.mockReset().mockResolvedValue(null);
  n++;
});

describe("proxy per-IP limit", () => {
  it("limits anonymous requests at 200 per minute", async () => {
    const ip = `10.1.0.${n}`;
    expect(await burst(200, () => request(ip))).toBe(200);
    expect((await proxy(request(ip))).status).toBe(429);
  });

  it("does not count requests with a valid session", async () => {
    getSession.mockResolvedValue({ user: { id: "u" } });
    const ip = `10.2.0.${n}`;
    const make = () => request(ip, { cookie: "better-auth.session_token=real" });
    expect(await burst(300, make)).toBe(200);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("does not count requests with a valid API token", async () => {
    findApiToken.mockResolvedValue({ id: "t" });
    const ip = `10.3.0.${n}`;
    expect(await burst(300, () => request(ip, { authorization: "Bearer vardo_good" }))).toBe(200);
  });

  it("counts a forged session cookie as anonymous", async () => {
    const ip = `10.4.0.${n}`;
    const make = () => request(ip, { cookie: "better-auth.session_token=forged" });
    expect(await burst(200, make)).toBe(200);
    expect((await proxy(make())).status).toBe(429);
  });

  it("counts a bogus bearer token as anonymous", async () => {
    const ip = `10.5.0.${n}`;
    const make = () => request(ip, { authorization: "Bearer nope" });
    await burst(200, make);
    expect((await proxy(make())).status).toBe(429);
  });

  it("stops looking up credentials once an address has used its budget", async () => {
    const ip = `10.6.0.${n}`;
    await burst(201, () => request(ip));
    getSession.mockClear();
    for (let i = 0; i < 20; i++) {
      await proxy(request(ip, { cookie: `better-auth.session_token=forged${i}` }));
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it("counts requests when the credential check throws", async () => {
    getSession.mockRejectedValue(new Error("db down"));
    const ip = `10.7.0.${n}`;
    const make = () => request(ip, { cookie: "better-auth.session_token=x" });
    await burst(200, make);
    expect((await proxy(make())).status).toBe(429);
  });
});
