import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminContext, captureTools, plainContext, selectChain } from "@/tests/helpers/mcp-tools";

// vardo_doctor exists only for an admin-scoped token held by a live instance admin, and a failing reader becomes a fail line.

const NOW = new Date();

const h = vi.hoisted(() => ({
  instanceAdmin: vi.fn(async () => true),
  heartbeats: vi.fn(),
  health: vi.fn(),
  snapshot: vi.fn(async () => ({})),
  infraRows: vi.fn(() => []),
  waiting: vi.fn(async () => 0),
  lapsed: [] as unknown[],
  systemJob: vi.fn(),
  jobs: vi.fn(),
  lastDrill: vi.fn(),
  backupsOn: vi.fn(async () => true),
  scan: vi.fn(),
  oom: vi.fn(async () => []),
  updateStatus: vi.fn(),
  orgIds: vi.fn(async () => ["org-1"]),
  attentionRows: vi.fn(async () => []),
  guardHistory: vi.fn(),
  bans: vi.fn(async () => []),
}));

vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: h.instanceAdmin }));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => selectChain(h.lapsed),
    selectDistinct: () => selectChain([]),
    query: { backupJobs: { findMany: h.jobs }, backups: { findFirst: h.lastDrill } },
  },
}));
vi.mock("@/lib/config/health", () => ({ getSystemHealth: h.health, sanitizeError: (s: string) => s.replace(/\d+\.\d+\.\d+\.\d+/, "[host]") }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: h.backupsOn }));
vi.mock("@/lib/attention/infrastructure", () => ({ getInfrastructureSnapshot: h.snapshot }));
vi.mock("@/lib/attention/infrastructure-rows", () => ({ infrastructureRows: h.infraRows }));
vi.mock("@/lib/attention/rows", () => ({ buildAttentionRows: h.attentionRows }));
vi.mock("@/lib/alerts/oom", () => ({ sharedOomKills: h.oom }));
vi.mock("@/lib/backups/engine", () => ({ STALE_RUN_MS: 3_600_000 }));
vi.mock("@/lib/backups/job-claim", () => ({ jobClaimKey: (id: string) => `backup:job-claim:${id}`, jobClaimHolder: vi.fn() }));
vi.mock("@/lib/backups/system-storage", () => ({ readSystemBackupJob: h.systemJob }));
vi.mock("@/lib/deploy/queue", () => ({ LEASE_TTL_MS: 45_000 }));
vi.mock("@/lib/deploy/waiting", () => ({ deploysWaitingForWorker: h.waiting }));
vi.mock("@/lib/probe-guard/history", () => ({ guardHistory: h.guardHistory }));
vi.mock("@/lib/probe-guard/bans", () => ({ listActiveBans: h.bans }));
vi.mock("@/lib/redis", () => ({ redis: { scan: h.scan } }));
vi.mock("@/lib/self-update/status", () => ({ getUpdateStatus: h.updateStatus }));
vi.mock("@/lib/worker/mode", () => ({ workerExpected: () => true, WORKER_FRESH_MS: 90_000 }));
vi.mock("@/lib/worker/watch", () => ({ readHostHeartbeats: h.heartbeats, watchdogSilent: () => false }));
vi.mock("@/lib/mcp/scope", () => ({
  canAdminInstance: async (c: { adminScope?: boolean }) => c.adminScope === true && (await h.instanceAdmin()),
  accessibleOrgIds: h.orgIds,
  orgLabels: async () => new Map([["org-1", { id: "org-1", name: "Acme", slug: "acme" }]]),
}));

import { registerDoctor } from "@/lib/mcp/tools/doctor";

type Report = { status: string; counts: Record<string, number>; lines: { check: string; status: string; label: string; detail?: string; fix?: string }[] };

function doctor(context = adminContext) {
  return captureTools(registerDoctor, context).get("vardo_doctor");
}

async function run() {
  const res = (await doctor()!({})) as unknown as { content: { text: string }[]; structuredContent: Report; isError?: boolean };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.instanceAdmin.mockResolvedValue(true);
  h.heartbeats.mockResolvedValue({ workerAt: NOW, workerReady: true, consoleAt: NOW, watchdogAt: NOW, now: NOW });
  h.health.mockResolvedValue({
    services: [{ name: "PostgreSQL", status: "healthy" }],
    resources: [
      { name: "Memory", percent: 40, status: "ok", detail: "4 GB / 10 GB" },
      { name: "Disk", percent: 91, status: "critical", detail: "91 GB / 100 GB" },
    ],
  });
  h.lapsed = [{ n: 0, oldestMs: null }];
  h.systemJob.mockResolvedValue({ job: { enabled: true, target: { name: "Offsite", type: "s3" } }, history: [] });
  h.jobs.mockResolvedValue([
    { id: "j1", name: "Auto: Nightly", schedule: "0 3 * * *", enabled: true, lastRunAt: NOW, createdAt: NOW, backups: [{ status: "failed" }] },
  ]);
  h.lastDrill.mockResolvedValue({ verifiedAt: NOW, verifyOutcome: "verified", verifyDetail: null, appName: "blog", jobName: null });
  h.scan.mockResolvedValue(["0", []]);
  h.updateStatus.mockResolvedValue({
    current: { version: "1.2.0" },
    policy: { mode: "auto" },
    channel: "releases",
    hostCommand: "sudo vardo update",
    update: { hasUpdate: true, targetLabel: "1.3.0", commitsBehind: null },
    checkError: null,
    active: null,
    run: null,
  });
  h.guardHistory.mockResolvedValue({ stats: { probes: 0, bans: 0, traps: 0 } });
});

describe("gating", () => {
  it("registers nothing without the admin scope", () => {
    expect(doctor(plainContext)).toBeUndefined();
  });

  it("refuses once the user is no longer an instance admin", async () => {
    h.instanceAdmin.mockResolvedValue(false);
    const res = await run();
    expect(res.isError).toBe(true);
    expect(h.heartbeats).not.toHaveBeenCalled();
  });
});

describe("vardo_doctor", () => {
  it("returns lines as text, JSON and structured content", async () => {
    const res = await run();
    const report = res.structuredContent;
    expect(JSON.parse(res.content[1].text)).toEqual(report);
    expect(res.content[0].text).toContain("FAIL  Disk 91% used · 91 GB / 100 GB\n      Fix: /metrics");
    expect(report.status).toBe("fail");
    expect(report.lines.map((l) => [l.check, l.status, l.label])).toEqual([
      ["worker", "pass", "Worker up"],
      ["services", "pass", "1 service healthy"],
      ["deploys", "pass", "No stuck deploys"],
      ["backups", "pass", "Backup storage set"],
      ["backups", "fail", "1 backup job failing"],
      ["backups", "pass", "Last restore drill passed"],
      ["backups", "pass", "No leftover backup claims"],
      ["resources", "pass", "Memory 40% used"],
      ["resources", "fail", "Disk 91% used"],
      ["resources", "pass", "No OOM kills in the last hour"],
      ["update", "warn", "Behind 1.3.0"],
      ["attention", "pass", "Nothing needs attention"],
      ["security", "pass", "Probe guard"],
    ]);
    expect(report.lines.find((l) => l.label === "1 backup job failing")?.detail).toBe("Nightly");
    expect(h.health).toHaveBeenCalledTimes(1);
  });

  it("turns a reader that throws into a fail line and runs the rest", async () => {
    h.updateStatus.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5"));
    const report = (await run()).structuredContent;
    expect(report.lines.find((l) => l.check === "update")).toEqual({
      check: "update",
      status: "fail",
      label: "Couldn't check updates",
      detail: "connect ECONNREFUSED [host]",
    });
    expect(report.lines.filter((l) => l.check === "security")).toHaveLength(1);
  });

  it("fails deploys past their lease", async () => {
    h.lapsed = [{ n: 2, oldestMs: "120000" }];
    const report = (await run()).structuredContent;
    expect(report.lines.find((l) => l.check === "deploys")).toMatchObject({
      status: "fail",
      label: "2 deploys past their lease",
      detail: "oldest lapsed 2m ago",
    });
  });

  it("links each overdue job to its card", async () => {
    const old = new Date(NOW.getTime() - 70 * 86_400_000);
    h.jobs.mockResolvedValue([
      { id: "j1", name: "Auto: fabric", schedule: "0 3 * * *", enabled: true, lastRunAt: old, createdAt: old, backups: [] },
      { id: "j2", name: "loki", schedule: "0 3 * * *", enabled: true, lastRunAt: null, createdAt: old, backups: [] },
    ]);
    const report = (await run()).structuredContent;
    expect(report.lines.filter((l) => l.label.endsWith("backup overdue"))).toEqual([
      { check: "backups", status: "warn", label: "fabric backup overdue", detail: "last ran 2mo ago", fix: "/backups#job-j1" },
      { check: "backups", status: "warn", label: "loki backup overdue", detail: "never ran", fix: "/backups#job-j2" },
    ]);
  });

  it("leaves out a core service row the failed probe already reported", async () => {
    h.health.mockResolvedValue({
      services: [{ name: "Loki", status: "unhealthy", error: "HTTP 503", logsHref: "/apps/loki/logs" }],
      resources: [],
    });
    h.snapshot.mockResolvedValue({ apps: [{ id: "app-loki", name: "loki", parentAppId: null }] });
    h.infraRows.mockReturnValue([
      { key: "core-service-down", label: "Core service down", tone: "error", items: [{ id: "app-loki", name: "Loki" }] },
    ] as never);
    const report = (await run()).structuredContent;
    expect(report.lines.filter((l) => l.check === "services")).toEqual([
      { check: "services", status: "fail", label: "Loki down", detail: "HTTP 503", fix: "/apps/loki/logs" },
    ]);
  });

  it("warns once when backups are off", async () => {
    h.backupsOn.mockResolvedValue(false);
    const report = (await run()).structuredContent;
    expect(report.lines.filter((l) => l.check === "backups")).toEqual([{ check: "backups", status: "warn", label: "Backups are off" }]);
  });
});
