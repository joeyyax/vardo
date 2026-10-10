// The engine runs org-level URL jobs without an app and records each run's HTTP details.

process.env.ENCRYPTION_MASTER_KEY ??= "c".repeat(64);

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

const m = vi.hoisted(() => ({
  runUrl: vi.fn(),
  policy: vi.fn(),
  failure: vi.fn(),
  success: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/redis-lock", () => ({ acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}) }));
vi.mock("@/lib/cron/http", () => ({ runUrlRequest: m.runUrl, cronOutboundPolicy: m.policy }));
vi.mock("@/lib/cron/alerts", () => ({ noteCronFailure: m.failure, noteCronSuccess: m.success }));
vi.mock("@/lib/docker/client", () => ({ listContainers: vi.fn(async () => []) }));
vi.mock("@/lib/utils/exec", () => ({ execFileAsync: m.exec }));

const { runCronJob, tickCronJobs, runLockTtlMs } = await import("@/lib/cron/engine");
const { encryptHeaders } = await import("@/lib/cron/headers");
const { cronJobRuns } = await import("@/lib/db/schema");

function orgJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    name: "Site cron",
    type: "url" as const,
    command: "https://example.com/wp-cron.php",
    organizationId: "org-1",
    schedule: "* * * * *",
    method: "GET",
    headers: null,
    timeoutMs: 30_000,
    retries: 2,
    expectedStatus: null,
    enabled: true,
    app: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  m.policy.mockResolvedValue({ allowlist: [] });
  dbMock.query.cronJobRuns.findFirst.mockResolvedValue(undefined);
  m.runUrl.mockResolvedValue({ success: true, log: "GET → 200", durationMs: 42, httpStatus: 200, attempts: 1, target: "https://example.com/wp-cron.php" });
});

describe("runCronJob", () => {
  it("runs an org-level URL job and records status, duration and attempts", async () => {
    const result = await runCronJob(orgJob());
    expect(result).toMatchObject({ status: "success", httpStatus: 200, durationMs: 42, attempts: 1 });
    const run = dbMock.inserts.find((i) => i.table === cronJobRuns)?.values;
    expect(run).toMatchObject({ cronJobId: "job-1", status: "success", httpStatus: 200, durationMs: 42, attempts: 1 });
    expect(m.success).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1", app: null }), expect.any(Date));
    expect(m.failure).not.toHaveBeenCalled();
  });

  it("passes the URL options and decrypted headers to the request", async () => {
    const headers = encryptHeaders([{ name: "X-Token", value: "s3cret-token" }], "org-1");
    await runCronJob(orgJob({ method: "POST", headers, timeoutMs: 5000, retries: 3, expectedStatus: "204" }));
    expect(m.policy).toHaveBeenCalledWith("org-1", "https://example.com/wp-cron.php");
    expect(m.runUrl).toHaveBeenCalledWith(
      {
        url: "https://example.com/wp-cron.php",
        method: "POST",
        headers: [{ name: "X-Token", value: "s3cret-token" }],
        timeoutMs: 5000,
        retries: 3,
        expectedStatus: "204",
      },
      { allowlist: [] },
    );
  });

  it("reports a failure through the alert throttle", async () => {
    m.runUrl.mockResolvedValue({ success: false, log: "GET → 500", durationMs: 9, httpStatus: 500, attempts: 3, target: "https://example.com/wp-cron.php" });
    const result = await runCronJob(orgJob());
    expect(result?.status).toBe("failed");
    const [alertJob, event] = m.failure.mock.calls[0];
    expect(alertJob).toMatchObject({ id: "job-1", organizationId: "org-1", app: null });
    expect(event).toMatchObject({ title: "Cron failed: Site cron", jobType: "url", exitCode: 500, appId: undefined });
  });

  it("refuses a command job with no app", async () => {
    const result = await runCronJob(orgJob({ type: "command", command: "id" }));
    expect(result?.status).toBe("failed");
    expect(m.exec).not.toHaveBeenCalled();
  });

  it("fails cleanly on headers it can't decrypt", async () => {
    const result = await runCronJob(orgJob({ headers: "enc:v1:bad:bad:bad" }));
    expect(result?.status).toBe("failed");
    expect(result?.output).toContain("decrypt");
    expect(m.runUrl).not.toHaveBeenCalled();
  });
});

describe("tickCronJobs", () => {
  it("runs due org-level jobs and skips jobs on apps that aren't active", async () => {
    dbMock.query.cronJobs.findMany.mockResolvedValue([
      orgJob({ id: "org-job" }),
      orgJob({ id: "stopped-app-job", app: { id: "a1", name: "web", status: "stopped", organizationId: "org-1", displayName: null } }),
      orgJob({ id: "orphan-command", type: "command", command: "id" }),
    ]);
    await tickCronJobs();
    expect(m.runUrl).toHaveBeenCalledTimes(1);
    expect(dbMock.inserts.filter((i) => i.table === cronJobRuns)).toHaveLength(1);
  });
});

describe("runLockTtlMs", () => {
  it("outlasts every attempt timing out plus backoff", () => {
    expect(runLockTtlMs({ type: "url", timeoutMs: 300_000, retries: 3 })).toBeGreaterThan(4 * 300_000 + 7_000);
  });
});
