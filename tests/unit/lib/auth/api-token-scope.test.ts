// A token carries its user's rights only up to its own grant: no instance-admin
// reach unless granted, no expiry once past it, and no minting or widening a
// token beyond the scope of the token doing it.

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

const ADMIN_USER = { id: "u1", name: "Joey", email: "j@x", isAppAdmin: true };

function token(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    userId: "u1",
    organizationId: "org-1",
    crossOrg: false,
    adminAccess: false,
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
  it("is withheld from a token without the grant, even for an admin user", async () => {
    tokenFindFirst.mockResolvedValue(token());

    const session = await getSession();
    expect(session?.user.isAppAdmin).toBe(false);
    expect(await isAppAdmin()).toBe(false);
    await expect(requireAppAdmin()).rejects.toThrow("Forbidden");
  });

  it("is carried by a granted token while the user is still an admin", async () => {
    tokenFindFirst.mockResolvedValue(token({ adminAccess: true }));

    expect(await isAppAdmin()).toBe(true);
    await expect(requireAppAdmin()).resolves.toBeTruthy();
  });

  it("lapses with the user's own admin role", async () => {
    tokenFindFirst.mockResolvedValue(token({ adminAccess: true }));
    userFindFirst.mockResolvedValue({ ...ADMIN_USER, isAppAdmin: false });

    expect(await isAppAdmin()).toBe(false);
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
  const narrow = { crossOrg: false, adminAccess: false, expiresAt: null };

  it("lets a cookie session grant anything its user holds", () => {
    expect(
      scopeCeilingViolation({
        caller: null,
        userIsAppAdmin: true,
        requested: { crossOrg: true, adminAccess: true, expiresAt: null },
      }),
    ).toBeNull();
  });

  it("never grants admin to a non-admin user", () => {
    expect(
      scopeCeilingViolation({ caller: null, userIsAppAdmin: false, requested: { adminAccess: true } }),
    ).toMatch(/admin/);
  });

  it("stops a token granting admin it does not hold", () => {
    expect(
      scopeCeilingViolation({ caller: narrow, userIsAppAdmin: true, requested: { adminAccess: true } }),
    ).toMatch(/admin/);
  });

  it("stops a token widening to other organizations", () => {
    expect(
      scopeCeilingViolation({ caller: narrow, userIsAppAdmin: true, requested: { crossOrg: true } }),
    ).toMatch(/organizations/);
  });

  it("stops a token minting one that outlives it", () => {
    const caller = { ...narrow, expiresAt: new Date(Date.now() + 60_000) };
    expect(
      scopeCeilingViolation({ caller, userIsAppAdmin: false, requested: { expiresAt: null } }),
    ).toMatch(/outlive/);
    expect(
      scopeCeilingViolation({
        caller,
        userIsAppAdmin: false,
        requested: { expiresAt: new Date(Date.now() + 120_000) },
      }),
    ).toMatch(/outlive/);
    expect(
      scopeCeilingViolation({
        caller,
        userIsAppAdmin: false,
        requested: { expiresAt: new Date(Date.now() + 30_000) },
      }),
    ).toBeNull();
  });

  it("allows narrowing", () => {
    const wide = { crossOrg: true, adminAccess: true, expiresAt: null };
    expect(
      scopeCeilingViolation({ caller: wide, userIsAppAdmin: true, requested: { crossOrg: false, adminAccess: false } }),
    ).toBeNull();
  });
});
