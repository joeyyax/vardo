// A command cron runs `sh -c` in the app container, so creating or changing one needs an admin.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { dbMock } from "@/tests/helpers/db";

const h = vi.hoisted(() => ({ role: "member" }));

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

const { POST, PATCH, DELETE } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/cron/route");

const params = { params: Promise.resolve({ orgId: "org-1", appId: "app-1" }) };
const url = "http://localhost/api/v1/organizations/org-1/apps/app-1/cron";
const call = (fn: typeof POST, method: string, body: unknown) =>
  fn(new NextRequest(url, { method, body: JSON.stringify(body) }), params);

const row = (type: "command" | "url", command: string) => ({ id: "c1", type, command });

beforeEach(() => {
  dbMock.reset();
  dbMock.query.apps.findFirst.mockResolvedValue({ id: "app-1", isSystemManaged: false });
  dbMock.insertReturns([{ id: "c1" }]);
  dbMock.updateReturns([{ id: "c1" }]);
  dbMock.deleteReturns([{ id: "c1" }]);
});

describe("member", () => {
  beforeEach(() => {
    h.role = "member";
  });

  const create = (type: string) =>
    call(POST, "POST", { name: "n", type, schedule: "* * * * *", command: type === "url" ? "https://x.test" : "id" });

  it("is refused a command cron", async () => {
    expect((await create("command")).status).toBe(403);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("is refused a command cron by default type", async () => {
    const res = await call(POST, "POST", { name: "n", schedule: "* * * * *", command: "id" });
    expect(res.status).toBe(403);
  });

  it("creates a URL cron", async () => {
    expect((await create("url")).status).toBe(201);
  });

  it("is refused editing a command", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(row("command", "ls"));
    expect((await call(PATCH, "PATCH", { id: "c1", command: "id" })).status).toBe(403);
    expect(dbMock.updates).toHaveLength(0);
  });

  it("is refused switching a URL cron to a command", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(row("url", "https://x.test"));
    expect((await call(PATCH, "PATCH", { id: "c1", type: "command", command: "id" })).status).toBe(403);
    expect((await call(PATCH, "PATCH", { id: "c1", type: "command" })).status).toBe(403);
  });

  it("edits a URL cron", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(row("url", "https://x.test"));
    expect((await call(PATCH, "PATCH", { id: "c1", command: "https://y.test" })).status).toBe(200);
  });

  it("pauses and reschedules a command cron", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(row("command", "ls"));
    expect((await call(PATCH, "PATCH", { id: "c1", enabled: false })).status).toBe(200);
    expect((await call(PATCH, "PATCH", { id: "c1", schedule: "0 * * * *", command: "ls" })).status).toBe(200);
  });

  it("deletes a command cron", async () => {
    expect((await call(DELETE, "DELETE", { id: "c1" })).status).toBe(200);
  });
});

describe("admin", () => {
  beforeEach(() => {
    h.role = "admin";
  });

  it("creates command and URL crons", async () => {
    const body = { name: "n", schedule: "* * * * *" };
    expect((await call(POST, "POST", { ...body, type: "command", command: "id" })).status).toBe(201);
    expect((await call(POST, "POST", { ...body, type: "url", command: "https://x.test" })).status).toBe(201);
  });

  it("edits a command and switches a URL cron to a command", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(row("command", "ls"));
    expect((await call(PATCH, "PATCH", { id: "c1", command: "id" })).status).toBe(200);
    dbMock.query.cronJobs.findFirst.mockResolvedValue(row("url", "https://x.test"));
    expect((await call(PATCH, "PATCH", { id: "c1", type: "command", command: "id" })).status).toBe(200);
  });
});
