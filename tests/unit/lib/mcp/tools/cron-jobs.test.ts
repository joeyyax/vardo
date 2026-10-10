// vardo_list/create/update/delete_cron_job: org-level URL jobs and app jobs, under the token's scope.

process.env.ENCRYPTION_MASTER_KEY ??= "f".repeat(64);

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

const { canAccessOrg, resolveTargetOrg } = vi.hoisted(() => ({ canAccessOrg: vi.fn(), resolveTargetOrg: vi.fn() }));

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/mcp/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/scope")>()),
  canAccessOrg,
  resolveTargetOrg,
  accessibleOrgIds: async () => ["o1"],
}));

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

async function tools(): Promise<Record<string, Handler>> {
  const { registerCronJobTools } = await import("@/lib/mcp/tools/cron-jobs");
  const found: Record<string, Handler> = {};
  const server = { tool: (name: string, _d: string, _s: unknown, fn: Handler) => void (found[name] = fn) };
  registerCronJobTools(server as never, { userId: "u1", organizationId: "o1", crossOrg: false } as never);
  return found;
}

const body = (r: Result) => JSON.parse(r.content[0].text);
const urlJob = { name: "Site cron", schedule: "*/10 * * * *", type: "url", command: "https://example.com/wp-cron.php", enabled: true };
const stored = (overrides: Record<string, unknown> = {}) => ({
  id: "c1",
  type: "url",
  command: "https://example.com/wp-cron.php",
  headers: null,
  appId: null,
  organizationId: "o1",
  organization: { isSystemManaged: false },
  app: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  canAccessOrg.mockResolvedValue(true);
  resolveTargetOrg.mockResolvedValue("o1");
  dbMock.query.organizations.findFirst.mockResolvedValue({ isSystemManaged: false });
  dbMock.insertReturns([{ id: "c1", organizationId: "o1", headers: null }]);
  dbMock.updateReturns([{ id: "c1", organizationId: "o1", headers: null }]);
});

describe("vardo_create_cron_job", () => {
  it("creates an org-level URL job with no app", async () => {
    const res = await (await tools()).vardo_create_cron_job({ ...urlJob, retries: 2, headers: [{ name: "X-Key", value: "s3cret" }] });
    expect(res.isError).toBeUndefined();
    const values = dbMock.inserts[0].values as Record<string, unknown>;
    expect(values).toMatchObject({ organizationId: "o1", appId: null, retries: 2 });
    expect(String(values.headers)).not.toContain("s3cret");
    expect(resolveTargetOrg).toHaveBeenCalledWith(expect.anything(), undefined, "app.cron");
  });

  it("refuses a command job without an app", async () => {
    const res = await (await tools()).vardo_create_cron_job({ ...urlJob, type: "command", command: "id" });
    expect(res.isError).toBe(true);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("refuses the system org", async () => {
    dbMock.query.organizations.findFirst.mockResolvedValue({ isSystemManaged: true });
    expect((await (await tools()).vardo_create_cron_job(urlJob)).isError).toBe(true);
  });

  it("refuses an org outside the token", async () => {
    resolveTargetOrg.mockResolvedValue(null);
    expect((await (await tools()).vardo_create_cron_job({ ...urlJob, organizationId: "o9" })).isError).toBe(true);
  });

  it("creates a command job on an app for an admin only", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({ id: "a1", organizationId: "o1", isSystemManaged: false, organization: { isSystemManaged: false } });
    canAccessOrg.mockImplementation(async (_c, _o, cap: string) => cap !== "app.cron.command");
    const t = await tools();
    expect((await t.vardo_create_cron_job({ ...urlJob, appId: "a1", type: "command", command: "id" })).isError).toBe(true);
    canAccessOrg.mockResolvedValue(true);
    expect((await t.vardo_create_cron_job({ ...urlJob, appId: "a1", type: "command", command: "id" })).isError).toBeUndefined();
    expect(dbMock.inserts[0].values).toMatchObject({ appId: "a1", type: "command" });
  });
});

describe("vardo_update_cron_job", () => {
  it("updates URL options", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(stored());
    const res = await (await tools()).vardo_update_cron_job({ cronJobId: "c1", retries: 3, method: "HEAD" });
    expect(res.isError).toBeUndefined();
    expect(dbMock.updates[0].set).toMatchObject({ retries: 3, method: "HEAD" });
  });

  it("refuses a member changing what a command job runs", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(stored({ type: "command", command: "ls", appId: "a1", app: { isSystemManaged: false } }));
    canAccessOrg.mockImplementation(async (_c, _o, cap: string) => cap !== "app.cron.command");
    const res = await (await tools()).vardo_update_cron_job({ cronJobId: "c1", command: "id" });
    expect(res.isError).toBe(true);
    expect(dbMock.updates).toHaveLength(0);
  });

  it("refuses turning an org-level job into a command", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(stored());
    expect((await (await tools()).vardo_update_cron_job({ cronJobId: "c1", type: "command", command: "id" })).isError).toBe(true);
  });
});

describe("vardo_delete_cron_job", () => {
  it("deletes a job in scope", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(stored());
    expect((await (await tools()).vardo_delete_cron_job({ cronJobId: "c1" })).isError).toBeUndefined();
    expect(dbMock.deletes).toHaveLength(1);
  });

  it("refuses a job out of scope", async () => {
    dbMock.query.cronJobs.findFirst.mockResolvedValue(stored());
    canAccessOrg.mockResolvedValue(false);
    expect((await (await tools()).vardo_delete_cron_job({ cronJobId: "c1" })).isError).toBe(true);
    expect(dbMock.deletes).toHaveLength(0);
  });
});

describe("vardo_list_cron_jobs", () => {
  it("lists jobs with headers masked", async () => {
    const { encryptHeaders } = await import("@/lib/cron/headers");
    dbMock.query.cronJobs.findMany.mockResolvedValue([
      { id: "c1", organizationId: "o1", headers: encryptHeaders([{ name: "X-Key", value: "s3cret" }], "o1") },
    ]);
    const res = await (await tools()).vardo_list_cron_jobs({ runs: 10 });
    expect(res.content[0].text).not.toContain("s3cret");
    expect(body(res).cronJobs[0].headers).toEqual([{ name: "X-Key", value: "****" }]);
  });
});
