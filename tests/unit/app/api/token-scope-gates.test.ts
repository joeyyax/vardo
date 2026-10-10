// A deploy-scoped token can't restore env vars by rollback, and a scoped token can't accept an invitation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";
import { tokenScopeCapabilities } from "@/lib/auth/permissions";
import { scopeAllowsAdmin } from "@/lib/auth/api-token";

const { mockVerifyOrgAccess, mockGetSession, requestDeploy } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockGetSession: vi.fn(),
  requestDeploy: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/auth/session", async (original) => ({
  ...(await original<typeof import("@/lib/auth/session")>()),
  getSession: mockGetSession,
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn().mockResolvedValue(true) }));

const rollback = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/rollback/route");
const { acceptInvitation } = await import("@/app/(public)/invite/[token]/actions");

function member(scope: "deploy" | "full") {
  mockVerifyOrgAccess.mockResolvedValue({
    membership: { role: "owner", scopes: tokenScopeCapabilities(scope, null) },
    session: { user: { id: "u1" }, authMethod: "token" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("rollback with env vars", () => {
  it("refuses a deploy-scoped token", async () => {
    member("deploy");
    const res = await rollback.POST(
      jsonRequest("POST", "/api/v1/organizations/o1/apps/a1/rollback", { body: { deploymentId: "d1", includeEnvVars: true } }),
      routeCtx({ orgId: "o1", appId: "a1" }),
    );
    expect(res.status).toBe(403);
    expect(requestDeploy).not.toHaveBeenCalled();
  });
});

describe("accepting an invitation", () => {
  it("refuses a scoped token", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u1", email: "a@example.com" },
      authMethod: "token",
      tokenScope: { crossOrg: false, expiresAt: null, capabilities: tokenScopeCapabilities("read", null) },
    });
    expect(await acceptInvitation("tok")).toEqual({ error: "A scoped API token can't accept invitations" });
  });
});

describe("admin scope", () => {
  it("never rides on a read-only token", () => {
    expect(scopeAllowsAdmin("read")).toBe(false);
    expect(scopeAllowsAdmin("full")).toBe(true);
    expect(scopeAllowsAdmin(null)).toBe(true);
  });
});
