// A token holds its scope intersected with the user's live role (#788). Runs the real
// session module, verify-access and routes with a scripted bearer token.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";
import { apiTokens } from "@/lib/db/schema";
import { can, tokenScopeCapabilities, type Capability } from "@/lib/auth/permissions";

const h = vi.hoisted(() => ({
  token: {} as Record<string, unknown>,
}));

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ authorization: "Bearer vardo_test" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/auth/api-token", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/api-token")>()),
  findApiToken: async () => h.token,
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: async () => true }));
vi.mock("@/lib/api/rate-limit", async () => (await import("@/tests/helpers/mocks")).rateLimitModule());
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { verifyOrgAccess, verifyAppAccess } = await import("@/lib/api/verify-access");
const { getSession } = await import("@/lib/auth/session");
const deployRoute = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/deploy/route");
const envRoute = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/env-vars/route");
const terminalRoute = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/terminal/route");
const orgsRoute = await import("@/app/api/v1/organizations/route");

const ctx = routeCtx({ orgId: "org-a", appId: "app-1" });

function useToken(scope: string | undefined, opts: { role?: string; capabilities?: string[]; crossOrg?: boolean } = {}) {
  h.token = {
    id: "t1",
    userId: "u1",
    organizationId: "org-a",
    crossOrg: opts.crossOrg ?? false,
    expiresAt: null,
    ...(scope !== undefined && { scope, capabilities: opts.capabilities ?? null }),
  };
  dbMock.query.memberships.findFirst.mockResolvedValue({
    id: "m1",
    role: opts.role ?? "admin",
    organizationId: "org-a",
    organization: { id: "org-a", name: "A", isSystemManaged: false },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  dbMock.query.user.findFirst.mockResolvedValue({ id: "u1", name: "U", email: "u@x", isAppAdmin: true });
  dbMock.query.apps.findFirst.mockResolvedValue({ id: "app-1", name: "web", isSystemManaged: false });
});

describe("tokenScopeCapabilities", () => {
  it("leaves full and pre-scope tokens unrestricted", () => {
    expect(tokenScopeCapabilities("full", null)).toBeNull();
    expect(tokenScopeCapabilities(undefined, undefined)).toBeNull();
  });

  it("limits read-only to views and masked env", () => {
    const read = tokenScopeCapabilities("read", null)!;
    expect([...read].every((c) => c.endsWith(".view") || c === "env.read")).toBe(true);
    expect(read.has("backup.view")).toBe(true);
    expect(read.has("env.reveal")).toBe(false);
  });

  it("adds only app.deploy for deploy", () => {
    const read = tokenScopeCapabilities("read", null)!;
    const deploy = tokenScopeCapabilities("deploy", null)!;
    expect([...deploy].filter((c) => !read.has(c))).toEqual(["app.deploy"]);
  });

  it("drops unknown capabilities and allows nothing for an unknown scope", () => {
    expect([...tokenScopeCapabilities("custom", ["app.view", "root.everything"])!]).toEqual(["app.view"]);
    expect(tokenScopeCapabilities("superuser", null)!.size).toBe(0);
  });

  it("never lifts a role", () => {
    const scopes = new Set<Capability>(["env.reveal"]);
    expect(can({ role: "member", scopes }, "env.reveal")).toBe(false);
    expect(can({ role: "admin", scopes }, "env.reveal")).toBe(true);
    expect(can({ role: "admin", scopes }, "env.read")).toBe(false);
  });
});

describe("read-only token", () => {
  beforeEach(() => useToken("read"));

  it("passes on view", async () => {
    for (const cap of ["org.view", "app.view", "backup.view", "env.read"] as Capability[]) {
      expect(await verifyOrgAccess("org-a", cap)).not.toBeNull();
    }
  });

  it("gets 403 on deploy", async () => {
    const res = await deployRoute.POST(jsonRequest("POST", "/deploy"), ctx);
    expect(res.status).toBe(403);
  });

  it("is refused env write", async () => {
    expect(await verifyAppAccess("org-a", "app-1", "env.write")).toBeNull();
    const res = await envRoute.PUT(jsonRequest("PUT", "/env-vars", { body: { content: "A=1" } }), ctx);
    expect(res.status).toBe(404);
    expect(dbMock.updates.filter((u) => u.table !== apiTokens)).toEqual([]);
  });

  it("gets 403 creating an org", async () => {
    const res = await orgsRoute.POST(jsonRequest("POST", "/organizations", { body: { name: "Other" } }));
    expect(res.status).toBe(403);
  });
});

describe("deploy token", () => {
  beforeEach(() => useToken("deploy"));

  it("can deploy", async () => {
    expect(await verifyAppAccess("org-a", "app-1", "app.deploy")).toMatchObject({ id: "app-1" });
  });

  it("reads masked env but can't reveal it", async () => {
    const res = await envRoute.GET(jsonRequest("GET", "/env-vars", { query: { reveal: "true" } }), ctx);
    expect(res.status).toBe(403);
  });

  it("can't open a terminal", async () => {
    const res = await terminalRoute.POST(jsonRequest("POST", "/terminal", { body: { sessionId: "s", data: "ls" } }), ctx);
    expect(res.status).toBe(403);
  });
});

describe("org binding", () => {
  it("gets 403 in another org", async () => {
    useToken("full");
    expect(await verifyOrgAccess("org-b", "org.view")).toBeNull();
    const res = await deployRoute.POST(jsonRequest("POST", "/deploy"), routeCtx({ orgId: "org-b", appId: "app-1" }));
    expect(res.status).toBe(403);
  });
});

describe("role ceiling", () => {
  it("a member's full token still can't reveal", async () => {
    useToken("full", { role: "member" });
    const res = await envRoute.GET(jsonRequest("GET", "/env-vars", { query: { reveal: "true" } }), ctx);
    expect(res.status).toBe(403);
  });

  it("a member's custom token naming env.reveal still can't reveal", async () => {
    useToken("custom", { role: "member", capabilities: ["app.view", "env.read", "env.reveal"] });
    expect(await verifyOrgAccess("org-a", "env.reveal")).toBeNull();
    expect(await verifyOrgAccess("org-a", "app.view")).not.toBeNull();
  });

  it("an instance admin's scoped token gets no backup grant", async () => {
    useToken("read", { role: "member" });
    expect(await verifyOrgAccess("org-a", "backup.delete")).toBeNull();
  });
});

describe("tokens made before scopes", () => {
  beforeEach(() => useToken(undefined));

  it("carry no scope on the session", async () => {
    const session = await getSession();
    expect(session).toMatchObject({ authMethod: "token", tokenScope: { capabilities: null } });
  });

  it("keep the admin's full role", async () => {
    for (const cap of ["app.deploy", "env.write", "env.reveal", "app.terminal", "org.settings"] as Capability[]) {
      expect(await verifyOrgAccess("org-a", cap)).not.toBeNull();
    }
  });

  it("still create orgs", async () => {
    dbMock.query.organizations.findFirst.mockResolvedValue(undefined);
    const res = await orgsRoute.POST(jsonRequest("POST", "/organizations", { body: { name: "Other" } }));
    expect(res.status).not.toBe(403);
  });
});
