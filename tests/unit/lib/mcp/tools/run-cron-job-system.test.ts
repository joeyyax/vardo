// MCP tokens never carry instance-admin power, so vardo_run_cron_job refuses
// the system org and system-managed apps for every token.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { cronFindFirst, runCronJob, canAccessOrg } = vi.hoisted(() => ({
  cronFindFirst: vi.fn(),
  runCronJob: vi.fn(),
  canAccessOrg: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { query: { cronJobs: { findFirst: cronFindFirst } } } }));
vi.mock("@/lib/cron/engine", () => ({ runCronJob }));
vi.mock("@/lib/mcp/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/scope")>()),
  canAccessOrg,
}));
vi.mock("@/lib/auth/admin", async () => (await import("@/tests/helpers/mocks")).adminModule());

type Handler = (args: { cronJobId: string }) => Promise<{ content: { text: string }[]; isError?: boolean }>;

async function handler(): Promise<Handler> {
  const { registerRunCronJob } = await import("@/lib/mcp/tools/run-cron-job");
  let captured: Handler | undefined;
  const server = { tool: (_n: string, _d: string, _s: unknown, fn: Handler) => void (captured = fn) };
  registerRunCronJob(server as never, { userId: "u1", organizationId: "o1", crossOrg: false } as never);
  return captured!;
}

function job(org: boolean, app: boolean) {
  return {
    id: "c1",
    type: "url",
    app: { id: "a1", organizationId: "o1", isSystemManaged: app, organization: { isSystemManaged: org } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  canAccessOrg.mockResolvedValue(true);
  runCronJob.mockResolvedValue({ status: "success" });
});

describe("vardo_run_cron_job", () => {
  it.each([
    ["the system org", true, false],
    ["a system-managed app", false, true],
  ])("refuses %s", async (_label, org, app) => {
    cronFindFirst.mockResolvedValue(job(org, app));
    const res = await (await handler())({ cronJobId: "c1" });
    expect(res.isError).toBe(true);
    expect(runCronJob).not.toHaveBeenCalled();
  });

  it("runs a job on an ordinary app", async () => {
    cronFindFirst.mockResolvedValue(job(false, false));
    const res = await (await handler())({ cronJobId: "c1" });
    expect(res.isError).toBeUndefined();
    expect(runCronJob).toHaveBeenCalled();
  });
});
