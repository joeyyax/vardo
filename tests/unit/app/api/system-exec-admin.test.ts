// Terminal and cron on the system org or a system-managed app run with Vardo's
// own host access, so they need a session-signed-in instance admin whatever
// the caller's org role.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const { mockVerifyOrgAccess, mockVerifyAppAccess, mockCreateExec, mockStartExec, runCronJob } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockVerifyAppAccess: vi.fn(),
  mockCreateExec: vi.fn(),
  mockStartExec: vi.fn(),
  runCronJob: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: mockVerifyOrgAccess,
  verifyAppAccess: mockVerifyAppAccess,
}));
vi.mock("@/lib/auth/admin", async () => (await import("@/tests/helpers/mocks")).adminModule());
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/docker/app-containers", () => ({
  listAppContainers: async () => [{ id: "c1", name: "vardo-frontend", state: "running" }],
}));
vi.mock("@/lib/docker/exec", () => ({ createExec: mockCreateExec, startExec: mockStartExec, resizeExec: vi.fn() }));
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/cron/engine", () => ({ runCronJob }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { isAppAdmin } = await import("@/lib/auth/admin");
const terminal = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/terminal/route");
const cron = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/cron/route");
const cronRun = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/cron/[cronId]/run/route");

const params = routeCtx({ orgId: "o1", appId: "a1", cronId: "c1" });
const base = "/api/v1/organizations/o1/apps/a1";

function target({ org, app }: { org: boolean; app: boolean }) {
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: "o1", isSystemManaged: org },
    membership: { role: "owner" },
    session: { user: { id: "u1" }, authMethod: "session" },
  });
  mockVerifyAppAccess.mockResolvedValue({ id: "a1", isSystemManaged: app });
  dbMock.query.apps.findFirst.mockResolvedValue({
    id: "a1",
    name: "vardo",
    status: "active",
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
    isSystemManaged: app,
    parentApp: null,
  });
}

const calls = {
  "GET terminal": () => terminal.GET(jsonRequest("GET", `${base}/terminal`), params),
  "POST cron": () =>
    cron.POST(
      jsonRequest("POST", `${base}/cron`, { body: { name: "x", schedule: "* * * * *", command: "id" } }),
      params,
    ),
  "PATCH cron": () => cron.PATCH(jsonRequest("PATCH", `${base}/cron`, { body: { id: "c1", enabled: false } }), params),
  "DELETE cron": () => cron.DELETE(jsonRequest("DELETE", `${base}/cron`, { body: { id: "c1" } }), params),
  "POST cron run": () => cronRun.POST(jsonRequest("POST", `${base}/cron/c1/run`), params),
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  vi.mocked(isAppAdmin).mockResolvedValue(false);
  dbMock.insertReturns([{ id: "c1" }]);
  dbMock.updateReturns([{ id: "c1" }]);
  dbMock.deleteReturns([{ id: "c1" }]);
  dbMock.query.cronJobs.findFirst.mockResolvedValue({ id: "c1", type: "command", app: {} });
  runCronJob.mockResolvedValue({ status: "success" });
  mockCreateExec.mockResolvedValue("exec-1");
  mockStartExec.mockResolvedValue({ on: vi.fn(), destroy: vi.fn(), destroyed: false, write: vi.fn() });
});

describe.each(Object.entries(calls))("%s", (_name, call) => {
  it.each([
    ["the system org", { org: true, app: false }],
    ["a system-managed app", { org: false, app: true }],
  ])("refuses an org owner who isn't an instance admin on %s", async (_label, flags) => {
    target(flags);
    const res = await call();
    expect(res.status).toBe(403);
    expect(mockCreateExec).not.toHaveBeenCalled();
    expect(runCronJob).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("allows an instance admin on the system org", async () => {
    target({ org: true, app: true });
    vi.mocked(isAppAdmin).mockResolvedValue(true);
    expect((await call()).status).toBeLessThan(300);
  });

  it("skips the admin check on an ordinary app", async () => {
    target({ org: false, app: false });
    expect((await call()).status).toBeLessThan(300);
    expect(isAppAdmin).not.toHaveBeenCalled();
  });
});

describe("POST terminal input", () => {
  it("refuses input once the opener is no longer an instance admin", async () => {
    target({ org: true, app: true });
    vi.mocked(isAppAdmin).mockResolvedValue(true);
    const opened = await terminal.GET(jsonRequest("GET", `${base}/terminal`), params);
    const sessionId = opened.headers.get("X-Terminal-Session")!;

    vi.mocked(isAppAdmin).mockResolvedValue(false);
    const res = await terminal.POST(
      jsonRequest("POST", `${base}/terminal`, {
        body: { sessionId, type: "input", data: Buffer.from("id\n").toString("base64") },
      }),
      params,
    );
    expect(res.status).toBe(403);
  });
});
