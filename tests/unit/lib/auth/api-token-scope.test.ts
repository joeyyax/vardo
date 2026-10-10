// A token never carries instance-admin reach, stops working once expired, and
// can't mint or widen a token beyond its own scope.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { tokenFindFirst, userFindFirst, headerMap, cookieSession } = vi.hoisted(() => ({
  tokenFindFirst: vi.fn(),
  userFindFirst: vi.fn(),
  headerMap: new Map<string, string>(),
  cookieSession: vi.fn(),
}));

vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headerMap.get(k.toLowerCase()) ?? null }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: cookieSession } } }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/config/vardo-config", () => ({
  systemSettingsToVardoConfig: vi.fn().mockResolvedValue({ config: {}, secrets: { smtp: "s3cret" } }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apiTokens: { findFirst: tokenFindFirst },
      user: { findFirst: userFindFirst },
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

import { getSession } from "@/lib/auth/session";
import { isAppAdmin, requireAppAdmin } from "@/lib/auth/admin";
import { scopeCeilingViolation, isTokenExpired } from "@/lib/auth/api-token";
import { GET as exportConfig } from "@/app/api/v1/admin/config/export/route";
import { NextRequest } from "next/server";

const ADMIN_USER = { id: "u1", name: "Alex", email: "j@x", isAppAdmin: true };

function token(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    userId: "u1",
    organizationId: "org-1",
    crossOrg: false,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  headerMap.clear();
  headerMap.set("authorization", "Bearer vardo_abc");
  cookieSession.mockResolvedValue(null);
  userFindFirst.mockResolvedValue(ADMIN_USER);
});

describe("instance-admin reach through a token", () => {
  it("is withheld from an admin user's token", async () => {
    tokenFindFirst.mockResolvedValue(token());

    const session = await getSession();
    expect(session?.user.isAppAdmin).toBe(false);
    expect(await isAppAdmin()).toBe(false);
    await expect(requireAppAdmin()).rejects.toThrow("Forbidden");
  });

  it("is withheld from a token minted with the retired admin grant", async () => {
    tokenFindFirst.mockResolvedValue(token({ adminAccess: true }));

    expect(await isAppAdmin()).toBe(false);
    await expect(requireAppAdmin()).rejects.toThrow("Forbidden");
  });

  it("keeps a token out of the secrets export", async () => {
    tokenFindFirst.mockResolvedValue(token({ adminAccess: true }));

    const res = await exportConfig(
      new NextRequest("http://localhost/api/v1/admin/config/export?include=secrets"),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("s3cret");
  });

  it("still holds for the same admin signed in with a session", async () => {
    headerMap.clear();
    cookieSession.mockResolvedValue({ user: { id: "u1", isAppAdmin: true }, session: { id: "s1" } });

    expect(await isAppAdmin()).toBe(true);
    await expect(requireAppAdmin()).resolves.toBeTruthy();
    const res = await exportConfig(
      new NextRequest("http://localhost/api/v1/admin/config/export?include=secrets"),
    );
    expect(res.status).toBe(200);
  });
});

describe("token expiry", () => {
  it("rejects an expired token", async () => {
    tokenFindFirst.mockResolvedValue(token({ expiresAt: new Date(Date.now() - 1000) }));

    expect(await getSession()).toBeNull();
  });

  it("accepts a token before its expiry and one with none", async () => {
    tokenFindFirst.mockResolvedValue(token({ expiresAt: new Date(Date.now() + 60_000) }));
    expect(await getSession()).not.toBeNull();

    tokenFindFirst.mockResolvedValue(token());
    expect(await getSession()).not.toBeNull();
  });

  it("treats the expiry instant itself as expired", () => {
    const now = new Date();
    expect(isTokenExpired({ expiresAt: now }, now)).toBe(true);
    expect(isTokenExpired({ expiresAt: null }, now)).toBe(false);
  });
});

describe("scopeCeilingViolation", () => {
  const narrow = { crossOrg: false, expiresAt: null };

  it("lets a cookie session grant any scope", () => {
    expect(
      scopeCeilingViolation({ caller: null, requested: { crossOrg: true, expiresAt: null } }),
    ).toBeNull();
  });

  it("stops a token widening to other organizations", () => {
    expect(
      scopeCeilingViolation({ caller: narrow, requested: { crossOrg: true } }),
    ).toMatch(/organizations/);
  });

  it("stops a token minting one that outlives it", () => {
    const caller = { ...narrow, expiresAt: new Date(Date.now() + 60_000) };
    expect(
      scopeCeilingViolation({ caller, requested: { expiresAt: null } }),
    ).toMatch(/outlive/);
    expect(
      scopeCeilingViolation({
        caller,
        requested: { expiresAt: new Date(Date.now() + 120_000) },
      }),
    ).toMatch(/outlive/);
    expect(
      scopeCeilingViolation({
        caller,
        requested: { expiresAt: new Date(Date.now() + 30_000) },
      }),
    ).toBeNull();
  });

  it("allows narrowing", () => {
    const wide = { crossOrg: true, expiresAt: null };
    expect(
      scopeCeilingViolation({ caller: wide, requested: { crossOrg: false } }),
    ).toBeNull();
  });
});
