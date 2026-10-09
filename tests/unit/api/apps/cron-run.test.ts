// Run now follows the cron edit rules: a member runs URL jobs, command jobs need an admin.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { dbMock } from "@/tests/helpers/db";

const h = vi.hoisted(() => ({ role: "member", run: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  requireOrg: async () => ({
    organization: { id: "org-1" },
    membership: { role: h.role },
    session: { user: { id: "u1" } },
  }),
}));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: async () => false }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/cron/engine", () => ({ runCronJob: h.run }));

const { POST } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/cron/[cronId]/run/route");

const params = { params: Promise.resolve({ orgId: "org-1", appId: "app-1", cronId: "c1" }) };
const call = () =>
  POST(new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-1/cron/c1/run", { method: "POST" }), params);

const result = { runId: "r1", status: "success", exitCode: 0, httpStatus: null, durationMs: 5, output: "ok" };

beforeEach(() => {
  dbMock.reset();
  h.run.mockReset().mockResolvedValue(result);
  dbMock.query.apps.findFirst.mockResolvedValue({ id: "app-1", isSystemManaged: false });
});

describe("member", () => {
  beforeEach(() => {
    h.role = "member";
  });

  it("runs a URL job", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue({ id: "c1", type: "url" });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).run).toEqual(result);
  });

  it("is refused a command job", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue({ id: "c1", type: "command" });
    expect((await call()).status).toBe(403);
    expect(h.run).not.toHaveBeenCalled();
  });
});

describe("admin", () => {
  beforeEach(() => {
    h.role = "admin";
  });

  it("runs a command job", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue({ id: "c1", type: "command" });
    expect((await call()).status).toBe(200);
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("404s an unknown job", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(undefined);
    expect((await call()).status).toBe(404);
  });

  it("409s a job already running", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue({ id: "c1", type: "url" });
    h.run.mockResolvedValue(null);
    expect((await call()).status).toBe(409);
  });
});
