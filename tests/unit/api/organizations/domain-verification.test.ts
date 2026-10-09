// Route guards for #891: refused hosts and the __default__ toggle.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { state } = vi.hoisted(() => ({
  state: { inserted: [] as Record<string, unknown>[], updated: [] as Record<string, unknown>[], currentBase: null as string | null },
}));

vi.mock("@/lib/domains/context", () => ({
  loadInstanceHosts: async () => ({ base: "vardo.test", console: ["console.vardo.test"] }),
  loadVerifiedZones: async () => [],
  proofForNewDomain: async (host: string) => {
    if (host === "vardo.test") return { refusal: "That's the instance base domain. Use a subdomain instead." };
    if (host === "console.vardo.test") return { refusal: "That's the console's own host." };
    return { verificationToken: "vardo-t", verifiedAt: null };
  },
}));
vi.mock("@/lib/db", () => {
  const insert = () => ({
    values: (v: Record<string, unknown>) => {
      state.inserted.push(v);
      return { returning: async () => [v] };
    },
  });
  const update = () => ({
    set: (v: Record<string, unknown>) => {
      state.updated.push(v);
      return { where: () => ({ returning: async () => [v] , then: (r: (x: unknown) => void) => r(undefined) }) };
    },
  });
  return {
    db: {
      insert,
      update,
      query: {
        organizations: { findFirst: async () => ({ baseDomain: state.currentBase }) },
        orgDomains: { findMany: async () => [] },
        domains: { findFirst: async () => null },
      },
    },
  };
});
vi.mock("@/lib/domains/shared-host", () => ({ hostHeldByOtherOrg: async (host: string) => host === "taken.com" }));
vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: async () => ({ organization: { trusted: false } }),
  verifyAppAccess: async () => ({ id: "app-1", isSystemManaged: false }),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ user: { id: "u" } }) }));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: async () => false }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/system-settings", () => ({ getSslConfig: async () => ({}), getPrimaryIssuer: () => "le", getDefaultCertResolver: () => "le", CERT_RESOLVERS: ["le", "le-dns", "google", "google-dns", "zerossl", "zerossl-dns"] }));

import { POST as postAppDomain } from "@/app/api/v1/organizations/[orgId]/apps/[appId]/domains/route";
import { PATCH as patchOrgDomain } from "@/app/api/v1/organizations/[orgId]/domains/route";
import { PATCH as patchOrg } from "@/app/api/v1/organizations/[orgId]/route";

const req = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(body) });
const appParams = { params: Promise.resolve({ orgId: "o1", appId: "app-1" }) };
const orgParams = { params: Promise.resolve({ orgId: "o1" }) };

beforeEach(() => {
  state.inserted = [];
  state.updated = [];
  state.currentBase = null;
});

describe("app domain POST", () => {
  it("stores an ordinary domain with its token, unverified (positive control)", async () => {
    const res = await postAppDomain(req("POST", { domain: "Acme.com" }), appParams);
    expect(res.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({ domain: "acme.com", verificationToken: "vardo-t", verifiedAt: null });
  });

  it("refuses the console host and the instance base domain", async () => {
    for (const domain of ["console.vardo.test", "vardo.test"]) {
      const res = await postAppDomain(req("POST", { domain }), appParams);
      expect(res.status).toBe(400);
    }
    expect(state.inserted).toEqual([]);
  });
});

describe("app domain POST path prefix", () => {
  it("stores a normalized prefix and the strip flag", async () => {
    const res = await postAppDomain(req("POST", { domain: "acme.com", pathPrefix: "docs/", stripPathPrefix: true }), appParams);
    expect(res.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({ domain: "acme.com", pathPrefix: "/docs", stripPathPrefix: true });
  });

  it("stores no prefix for the whole host", async () => {
    const res = await postAppDomain(req("POST", { domain: "acme.com", pathPrefix: "/" }), appParams);
    expect(res.status).toBe(201);
    expect(state.inserted[0]).toMatchObject({ pathPrefix: null, stripPathPrefix: false });
  });

  it("refuses a prefix that could rewrite the rule", async () => {
    for (const pathPrefix of ["/a`) || Host(`x.com", "/a b", "/a?b", "/../x", "/docs/."]) {
      const res = await postAppDomain(req("POST", { domain: "acme.com", pathPrefix }), appParams);
      expect(res.status).toBe(400);
    }
    expect(state.inserted).toEqual([]);
  });

  it("refuses a path on a host another organization routes", async () => {
    const res = await postAppDomain(req("POST", { domain: "taken.com", pathPrefix: "/docs" }), appParams);
    expect(res.status).toBe(409);
    expect(state.inserted).toEqual([]);
  });
});

describe("org domains __default__ toggle", () => {
  it("saves the placeholder unverified", async () => {
    const res = await patchOrgDomain(req("PATCH", { id: "__default__", enabled: true }), orgParams);
    expect(res.status).toBe(200);
    expect(state.inserted[0]).toMatchObject({ isDefault: true, verified: false });
    expect(state.inserted[0].verifiedAt).toBeUndefined();
  });
});

describe("org PATCH baseDomain", () => {
  it("refuses the instance base domain and the console host", async () => {
    for (const baseDomain of ["vardo.test", "console.vardo.test"]) {
      const res = await patchOrg(req("PATCH", { baseDomain }), orgParams);
      expect(res.status).toBe(400);
    }
    expect(state.updated).toEqual([]);
  });

  it("starts a challenge for a new external base domain", async () => {
    const res = await patchOrg(req("PATCH", { baseDomain: "acme.com" }), orgParams);
    expect(res.status).toBe(200);
    expect(state.updated[0]).toMatchObject({ baseDomain: "acme.com", baseDomainVerifiedAt: null });
    expect(String(state.updated[0].baseDomainToken)).toMatch(/^vardo-/);
  });

  it("accepts re-saving a stored value, so existing installs keep theirs", async () => {
    state.currentBase = "vardo.test";
    const res = await patchOrg(req("PATCH", { baseDomain: "vardo.test" }), orgParams);
    expect(res.status).toBe(200);
  });
});
