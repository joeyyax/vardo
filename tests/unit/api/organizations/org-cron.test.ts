// /api/v1/organizations/[orgId]/cron: org-level URL jobs. Members manage them, viewers only read,
// the system org needs an instance admin and app jobs stay on the app routes.

process.env.ENCRYPTION_MASTER_KEY ??= "e".repeat(64);

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const h = vi.hoisted(() => ({ role: "member", orgId: "org-1", system: false, run: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  requireOrg: async () => ({
    organization: { id: h.orgId, isSystemManaged: h.system },
    membership: { role: h.role },
    session: { user: { id: "u1" } },
  }),
}));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: async () => false }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/cron/engine", () => ({ runCronJob: h.run }));

const list = await import("@/app/api/v1/organizations/[orgId]/cron/route");
const one = await import("@/app/api/v1/organizations/[orgId]/cron/[cronId]/route");
const run = await import("@/app/api/v1/organizations/[orgId]/cron/[cronId]/run/route");
const { encryptHeaders } = await import("@/lib/cron/headers");

const base = "/api/v1/organizations/org-1/cron";
const orgCtx = routeCtx({ orgId: "org-1" });
const jobCtx = routeCtx({ orgId: "org-1", cronId: "c1" });

const create = (body: Record<string, unknown>) => list.POST(jsonRequest("POST", base, { body }), orgCtx);
const valid = { name: "Site cron", schedule: "*/10 * * * *", command: "https://example.com/wp-cron.php" };

const orgRow = {
  id: "c1",
  organizationId: "org-1",
  appId: null,
  type: "url",
  command: "https://example.com/wp-cron.php",
  headers: null as string | null,
};

beforeEach(() => {
  dbMock.reset();
  h.role = "member";
  h.orgId = "org-1";
  h.system = false;
  h.run.mockReset().mockResolvedValue({ runId: "r1", status: "success", httpStatus: 200, durationMs: 5, attempts: 1 });
  dbMock.insertReturns([{ ...orgRow }]);
  dbMock.updateReturns([{ ...orgRow }]);
  dbMock.deleteReturns([{ id: "c1" }]);
  dbMock.query.cronJobs.findFirst.mockResolvedValue({ ...orgRow, app: null });
});

describe("POST", () => {
  it("creates an org-level URL job with no app", async () => {
    const res = await create({ ...valid, method: "POST", retries: 2, timeoutMs: 10_000, expectedStatus: "2xx" });
    expect(res.status).toBe(201);
    expect(dbMock.inserts[0].values).toMatchObject({
      organizationId: "org-1",
      appId: null,
      type: "url",
      method: "POST",
      retries: 2,
      timeoutMs: 10_000,
      expectedStatus: "2xx",
    });
  });

  it("encrypts headers and returns them masked", async () => {
    const stored = encryptHeaders([{ name: "X-Token", value: "s3cret-value" }], "org-1");
    dbMock.insertReturns([{ ...orgRow, headers: stored }]);
    const res = await create({ ...valid, headers: [{ name: "X-Token", value: "s3cret-value" }] });
    const values = dbMock.inserts[0].values as { headers: string };
    expect(values.headers).toMatch(/^enc:v1:/);
    expect(values.headers).not.toContain("s3cret");
    const text = await res.text();
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("enc:v1");
    expect(JSON.parse(text).cronJob.headers).toEqual([{ name: "X-Token", value: "****" }]);
  });

  it("refuses a command job", async () => {
    expect((await create({ ...valid, type: "command", command: "id" })).status).toBe(400);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it.each([
    ["a bad schedule", { schedule: "every tuesday" }],
    ["a non-http URL", { command: "file:///etc/passwd" }],
    ["a timeout over five minutes", { timeoutMs: 600_000 }],
    ["more than three retries", { retries: 4 }],
    ["an unknown method", { method: "DELETE" }],
    ["a bad expected status", { expectedStatus: "ok" }],
    ["a header with no value", { headers: [{ name: "X-Token" }] }],
    ["a reserved header", { headers: [{ name: "Host", value: "x" }] }],
  ])("refuses %s", async (_label, patch) => {
    expect((await create({ ...valid, ...patch })).status).toBe(400);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("refuses a viewer", async () => {
    h.role = "viewer";
    expect((await create(valid)).status).toBe(403);
  });

  it("refuses another org", async () => {
    h.orgId = "org-2";
    expect((await create(valid)).status).toBe(403);
  });

  it("refuses the system org without an instance admin", async () => {
    h.system = true;
    expect((await create(valid)).status).toBe(403);
  });
});

describe("GET", () => {
  it("lets a viewer list every job in the org", async () => {
    h.role = "viewer";
    dbMock.query.cronJobs.findMany.mockResolvedValue([{ ...orgRow }, { ...orgRow, id: "c2", appId: "a1" }]);
    const res = await list.GET(jsonRequest("GET", base), orgCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).cronJobs).toHaveLength(2);
  });

  it("returns a job with its recent runs", async () => {
    dbMock.query.cronJobRuns.findMany.mockResolvedValue([{ id: "r1", status: "success", httpStatus: 200 }]);
    const res = await one.GET(jsonRequest("GET", `${base}/c1`), jobCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).runs).toHaveLength(1);
  });
});

describe("PATCH and DELETE", () => {
  it("updates an org-level job", async () => {
    const res = await one.PATCH(jsonRequest("PATCH", `${base}/c1`, { body: { enabled: false, retries: 1 } }), jobCtx);
    expect(res.status).toBe(200);
    expect(dbMock.updates[0].set).toMatchObject({ enabled: false, retries: 1 });
  });

  it("keeps stored header values the client sends back masked", async () => {
    const stored = encryptHeaders([{ name: "X-Token", value: "s3cret-value" }], "org-1");
    dbMock.query.cronJobs.findFirst.mockResolvedValue({ ...orgRow, headers: stored });
    await one.PATCH(jsonRequest("PATCH", `${base}/c1`, { body: { headers: [{ name: "X-Token", value: "****" }] } }), jobCtx);
    const { decryptHeaders } = await import("@/lib/cron/headers");
    const set = dbMock.updates[0].set as { headers: string };
    expect(decryptHeaders(set.headers, "org-1")).toEqual([{ name: "X-Token", value: "s3cret-value" }]);
  });

  it("refuses to turn an org-level job into a command", async () => {
    const res = await one.PATCH(jsonRequest("PATCH", `${base}/c1`, { body: { type: "command" } }), jobCtx);
    expect(res.status).toBe(400);
  });

  it("404s an app job, which stays on the app routes", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(undefined);
    dbMock.updateReturns([]);
    dbMock.deleteReturns([]);
    expect((await one.PATCH(jsonRequest("PATCH", `${base}/c1`, { body: { enabled: false } }), jobCtx)).status).toBe(404);
    expect((await one.DELETE(jsonRequest("DELETE", `${base}/c1`), jobCtx)).status).toBe(404);
  });

  it("refuses a viewer", async () => {
    h.role = "viewer";
    expect((await one.PATCH(jsonRequest("PATCH", `${base}/c1`, { body: { enabled: false } }), jobCtx)).status).toBe(403);
    expect((await one.DELETE(jsonRequest("DELETE", `${base}/c1`), jobCtx)).status).toBe(403);
    expect(dbMock.updates).toHaveLength(0);
    expect(dbMock.deletes).toHaveLength(0);
  });

  it("deletes an org-level job", async () => {
    expect((await one.DELETE(jsonRequest("DELETE", `${base}/c1`), jobCtx)).status).toBe(200);
  });
});

describe("run now", () => {
  const post = () => run.POST(jsonRequest("POST", `${base}/c1/run`), jobCtx);

  it("runs an org-level job for a member", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("refuses a member an app's command job", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue({ ...orgRow, type: "command", appId: "a1", app: { id: "a1", isSystemManaged: false } });
    expect((await post()).status).toBe(403);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("refuses a job on a system-managed app", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue({ ...orgRow, appId: "a1", app: { id: "a1", isSystemManaged: true } });
    expect((await post()).status).toBe(403);
  });

  it("refuses a viewer", async () => {
    h.role = "viewer";
    expect((await post()).status).toBe(403);
  });

  it("409s a job already running", async () => {
    h.run.mockResolvedValue(null);
    expect((await post()).status).toBe(409);
  });

  it("404s a job in another org", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(undefined);
    expect((await post()).status).toBe(404);
  });
});
