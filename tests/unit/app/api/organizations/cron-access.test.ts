// /api/v1/organizations/[orgId]/apps/[appId]/cron
//
// Cron is app config. A member creates URL jobs and pauses or deletes any job;
// a viewer is refused. Command jobs: tests/unit/api/apps/cron-command.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const { mockVerifyOrgAccess, mockVerifyAppAccess } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockVerifyAppAccess: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", async () => {
  const { gateOrgAccess } = await import("../../../helpers/verify-access");
  return { verifyOrgAccess: gateOrgAccess(mockVerifyOrgAccess), verifyAppAccess: mockVerifyAppAccess };
});
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { POST, PATCH, DELETE } = await import(
  "@/app/api/v1/organizations/[orgId]/apps/[appId]/cron/route"
);

const ORG_ID = "org-1";
const APP_ID = "app-1";
const params = routeCtx({ orgId: ORG_ID, appId: APP_ID });

function req(method: string, body: unknown) {
  return jsonRequest(method, `/api/v1/organizations/${ORG_ID}/apps/${APP_ID}/cron`, { body });
}

function as(role: string) {
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: ORG_ID },
    membership: { role },
    session: { user: { id: "u1" }, authMethod: "session" },
  });
}

const calls = {
  POST: () => POST(req("POST", { name: "x", type: "url", schedule: "* * * * *", command: "https://x.test" }), params),
  PATCH: () => PATCH(req("PATCH", { id: "c1", enabled: false }), params),
  DELETE: () => DELETE(req("DELETE", { id: "c1" }), params),
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  dbMock.insertReturns([{ id: "c1" }]);
  dbMock.updateReturns([{ id: "c1" }]);
  dbMock.deleteReturns([{ id: "c1" }]);
  mockVerifyAppAccess.mockResolvedValue({ id: APP_ID, isSystemManaged: false });
  dbMock.query.cronJobs.findFirst.mockResolvedValue({ type: "url", command: "https://x.test", headers: null });
});

describe.each(Object.entries(calls))("cron %s", (_method, call) => {
  it("denies a viewer", async () => {
    as("viewer");
    expect((await call()).status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.delete).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it.each(["member", "admin", "owner"])("allows an org %s", async (role) => {
    as(role);
    expect((await call()).status).toBeLessThan(300);
  });
});
