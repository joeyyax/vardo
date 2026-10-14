// POST .../deployments/[deploymentId]/bump: instance admins move a waiting deploy to the front, recorded in activity.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: true,
  member: true,
  bump: vi.fn(),
  record: vi.fn(),
  appsFindFirst: vi.fn(),
  deploymentsFindFirst: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn(async () => (h.member ? { organization: { id: "org-1" }, membership: { role: "member" }, session: { user: { id: "u1" } } } : null)),
}));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/activity/record", () => ({ recordActivity: h.record }));
vi.mock("@/lib/deploy/bump", () => ({ bumpDeploy: h.bump }));
vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findFirst: h.appsFindFirst }, deployments: { findFirst: h.deploymentsFindFirst } } },
}));

const { POST } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]/bump/route");

const call = () =>
  POST(new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-a/deployments/d1/bump", { method: "POST" }), {
    params: Promise.resolve({ orgId: "org-1", appId: "app-a", deploymentId: "d1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h, { admin: true, member: true });
  h.appsFindFirst.mockResolvedValue({ id: "app-a" });
  h.deploymentsFindFirst.mockResolvedValue({ id: "d1" });
  h.bump.mockResolvedValue("deploy");
  h.record.mockResolvedValue(undefined);
});

describe("POST deployments/[deploymentId]/bump", () => {
  it("moves the deploy and records who did it", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queue: "deploy" });
    expect(h.bump).toHaveBeenCalledWith("d1");
    expect(h.record).toHaveBeenCalledWith({
      organizationId: "org-1",
      action: "deployment.bumped",
      appId: "app-a",
      userId: "u1",
      metadata: { deploymentId: "d1", queue: "deploy" },
    });
  });

  it("refuses anyone but an instance admin", async () => {
    h.admin = false;
    expect((await call()).status).toBe(403);
    h.admin = true;
    h.member = false;
    expect((await call()).status).toBe(403);
    expect(h.bump).not.toHaveBeenCalled();
  });

  it("refuses a deploy that isn't waiting, and records nothing", async () => {
    h.bump.mockResolvedValue(null);
    expect((await call()).status).toBe(409);
    expect(h.record).not.toHaveBeenCalled();
  });

  it("is a 404 for another app's deployment", async () => {
    h.deploymentsFindFirst.mockResolvedValue(undefined);
    expect((await call()).status).toBe(404);
  });
});
