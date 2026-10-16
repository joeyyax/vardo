import { describe, it, expect, vi, afterEach } from "vitest";
import type { AttentionRow } from "@/lib/ui/attention";
import {
  attentionLines,
  backupJobLines,
  backupStorageLines,
  claimLines,
  deployQueueLines,
  drillLines,
  formatReport,
  names,
  oomLines,
  resourceLines,
  runCheck,
  runDoctor,
  securityLines,
  serviceLines,
  updateLines,
  workerLines,
  type DoctorLine,
} from "@/lib/mcp/tools/doctor-checks";

const NOW = new Date("2026-10-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const statuses = (lines: DoctorLine[]) => lines.map((l) => l.status);

afterEach(() => {
  vi.useRealTimers();
});

describe("names", () => {
  it("joins up to three and counts the rest", () => {
    expect(names(["a"])).toBe("a");
    expect(names(["a", "b"])).toBe("a and b");
    expect(names(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});

describe("runCheck", () => {
  it("returns the check's lines", async () => {
    const lines = await runCheck({ name: "x", title: "x", run: async () => [{ check: "x", status: "pass", label: "ok" }] });
    expect(lines).toEqual([{ check: "x", status: "pass", label: "ok" }]);
  });

  it("turns a throw into a fail line with the described error", async () => {
    const lines = await runCheck(
      { name: "backups", title: "backup jobs", run: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:5432"); } },
      () => "connect ECONNREFUSED [host]",
    );
    expect(lines).toEqual([{ check: "backups", status: "fail", label: "Couldn't check backup jobs", detail: "connect ECONNREFUSED [host]" }]);
  });

  it("turns a synchronous throw into a fail line", async () => {
    const lines = await runCheck({ name: "x", title: "x", run: () => { throw new Error("sync"); } });
    expect(lines[0]).toMatchObject({ status: "fail", detail: "sync" });
  });

  it("fails a check that runs past its timeout", async () => {
    vi.useFakeTimers();
    const pending = runCheck({ name: "update", title: "updates", run: () => new Promise(() => {}), timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual([{ check: "update", status: "fail", label: "Couldn't check updates", detail: "Timed out after 2s" }]);
  });
});

describe("runDoctor", () => {
  it("keeps going past a failing check and reports the worst status", async () => {
    const report = await runDoctor(
      [
        { name: "a", title: "a", run: async () => [{ check: "a", status: "pass", label: "fine" }] },
        { name: "b", title: "b", run: async () => { throw new Error("boom"); } },
        { name: "c", title: "c", run: async () => [{ check: "c", status: "warn", label: "meh" }] },
      ],
      undefined,
      NOW,
    );
    expect(report.status).toBe("fail");
    expect(report.counts).toEqual({ pass: 1, warn: 1, fail: 1 });
    expect(report.lines.map((l) => l.check)).toEqual(["a", "b", "c"]);
    expect(report.checkedAt).toBe(NOW.toISOString());
  });

  it("passes when every line passes", async () => {
    const report = await runDoctor([{ name: "a", title: "a", run: async () => [{ check: "a", status: "pass", label: "fine" }] }]);
    expect(report.status).toBe("pass");
  });
});

describe("formatReport", () => {
  it("puts the fix under its line and counts at the end", () => {
    const text = formatReport({
      status: "fail",
      counts: { pass: 1, warn: 0, fail: 1 },
      checkedAt: NOW.toISOString(),
      lines: [
        { check: "worker", status: "fail", label: "Worker down", detail: "last beat 5 min ago", fix: "vardo worker status" },
        { check: "deploys", status: "pass", label: "No stuck deploys" },
      ],
    });
    expect(text).toBe(
      "FAIL  Worker down · last beat 5 min ago\n      Fix: vardo worker status\nPASS  No stuck deploys\n\n1 pass, 0 warnings, 1 failure",
    );
  });
});

describe("workerLines", () => {
  const base = { expected: true, workerReady: true, workerAt: ago(4_000), watchdogSilent: false, now: NOW, freshMs: 90_000 };

  it("passes a ready worker", () => {
    expect(workerLines(base)).toEqual([{ check: "worker", status: "pass", label: "Worker up", detail: "last beat just now" }]);
  });

  it("passes when loops run in the console", () => {
    expect(statuses(workerLines({ ...base, expected: false, workerReady: false, workerAt: null }))).toEqual(["pass"]);
  });

  it("warns on a fresh beat from a worker that isn't ready", () => {
    expect(workerLines({ ...base, workerReady: false })[0]).toMatchObject({ status: "warn", fix: "vardo worker status" });
  });

  it("fails a stale or missing worker", () => {
    expect(workerLines({ ...base, workerReady: false, workerAt: ago(5 * 60_000) })[0]).toMatchObject({
      status: "fail",
      label: "Worker down",
      detail: "last beat 5m ago",
    });
    expect(workerLines({ ...base, workerReady: false, workerAt: null })[0]).toMatchObject({ status: "fail", detail: "Never seen" });
  });

  it("warns on a silent watchdog", () => {
    expect(statuses(workerLines({ ...base, watchdogSilent: true }))).toEqual(["pass", "warn"]);
  });
});

describe("serviceLines", () => {
  it("passes healthy services in one line and fails each unhealthy one with its logs", () => {
    const lines = serviceLines(
      [
        { name: "PostgreSQL", status: "healthy" },
        { name: "Redis", status: "healthy" },
        { name: "Loki", status: "unhealthy", error: "HTTP 503", logsHref: "/apps/loki/logs" },
        { name: "WireGuard", status: "unconfigured" },
      ],
      [],
    );
    expect(lines).toEqual([
      { check: "services", status: "pass", label: "2 services healthy", detail: "PostgreSQL, Redis" },
      { check: "services", status: "fail", label: "Loki down", detail: "HTTP 503", fix: "/apps/loki/logs" },
    ]);
  });

  it("drops core service items a failed probe already reported", () => {
    const rows: AttentionRow[] = [
      {
        key: "core-service-down",
        label: "Core service down",
        tone: "error",
        items: [
          { id: "app-collector", name: "Collector" },
          { id: "app-loki-child", name: "Loki · loki" },
        ],
        action: { label: "Open", href: "/admin/settings/core-services" },
      },
      { key: "vardo-stack-degraded", label: "Vardo degraded", tone: "error", items: [{ id: "alert-1", name: "Traefik" }] },
    ];
    const apps = [
      { id: "app-collector", name: "collector", parentAppId: null },
      { id: "app-loki", name: "loki", parentAppId: null },
      { id: "app-loki-child", name: "loki-loki", parentAppId: "app-loki" },
    ];
    const down = (name: string) => ({ name, status: "unhealthy" as const, error: "fetch failed" });

    expect(serviceLines([down("Collector"), down("Loki"), down("Traefik")], rows, apps).map((l) => l.label)).toEqual([
      "Collector down",
      "Loki down",
      "Traefik down",
    ]);
    expect(serviceLines([down("Loki")], rows, apps)).toEqual([
      { check: "services", status: "fail", label: "Loki down", detail: "fetch failed" },
      { check: "services", status: "fail", label: "Core service down", detail: "Collector", fix: "/admin/settings/core-services" },
      { check: "services", status: "fail", label: "Vardo degraded", detail: "Traefik" },
    ]);
  });

  it("adds the core service rows", () => {
    const rows: AttentionRow[] = [
      { key: "core-service-down", label: "Core service down", tone: "error", items: [{ id: "c", name: "Collector" }], action: { label: "Open", href: "/admin/settings/core-services" } },
    ];
    expect(serviceLines([], rows)).toEqual([
      { check: "services", status: "fail", label: "Core service down", detail: "Collector", fix: "/admin/settings/core-services" },
    ]);
  });
});

describe("deployQueueLines", () => {
  it("passes an empty queue", () => {
    expect(statuses(deployQueueLines({ pastLease: 0, oldestPastLeaseMs: null, waitingOnWorker: 0 }))).toEqual(["pass"]);
  });

  it("fails deploys past their lease and deploys waiting on the worker", () => {
    const lines = deployQueueLines({ pastLease: 2, oldestPastLeaseMs: 3 * 60_000, waitingOnWorker: 1 });
    expect(lines).toEqual([
      { check: "deploys", status: "fail", label: "2 deploys past their lease", detail: "oldest lapsed 3m ago", fix: "vardo worker status" },
      { check: "deploys", status: "fail", label: "1 deploy waiting on a missing worker", fix: "vardo worker status" },
    ]);
  });
});

describe("backupStorageLines", () => {
  it("fails without a job or storage", () => {
    expect(backupStorageLines({ job: null })[0]).toMatchObject({ status: "fail", fix: "/admin/settings/backup" });
    expect(backupStorageLines({ job: { enabled: true, target: null } })[0]).toMatchObject({ status: "fail" });
  });

  it("warns when the job is off and passes with storage", () => {
    expect(statuses(backupStorageLines({ job: { enabled: false, target: { name: "r2", type: "r2" } } }))).toEqual(["warn"]);
    expect(backupStorageLines({ job: { enabled: true, target: { name: "Offsite", type: "s3" } } })).toEqual([
      { check: "backups", status: "pass", label: "Backup storage set", detail: "Offsite (s3)" },
    ]);
  });
});

describe("backupJobLines", () => {
  it("passes jobs on schedule", () => {
    expect(backupJobLines({ enabledJobs: 3, failing: [], overdue: [], now: NOW })).toEqual([
      { check: "backups", status: "pass", label: "3 backup jobs on schedule" },
    ]);
  });

  it("warns when no job is enabled", () => {
    expect(statuses(backupJobLines({ enabledJobs: 0, failing: [], overdue: [], now: NOW }))).toEqual(["warn"]);
  });

  it("fails failing jobs and warns each overdue job with its own last run, oldest first", () => {
    const lines = backupJobLines({
      enabledJobs: 6,
      failing: ["Nightly"],
      overdue: [
        { id: "j-hourly", name: "Hourly", since: ago(3 * 3_600_000), neverRan: false },
        { id: "j-weekly", name: "Weekly", since: ago(20 * 86_400_000), neverRan: false },
        { id: "j-new", name: "Fresh", since: ago(2 * 86_400_000), neverRan: true },
        { id: "j-4", name: "Fourth", since: ago(5 * 3_600_000), neverRan: false },
      ],
      now: NOW,
    });
    expect(lines[0]).toMatchObject({ status: "fail", label: "1 backup job failing", detail: "Nightly" });
    expect(lines.slice(1)).toEqual([
      { check: "backups", status: "warn", label: "Weekly backup overdue", detail: "last ran 2w ago", fix: "/backups#job-j-weekly" },
      { check: "backups", status: "warn", label: "Fresh backup overdue", detail: "never ran", fix: "/backups#job-j-new" },
      { check: "backups", status: "warn", label: "Fourth backup overdue", detail: "last ran 5h ago", fix: "/backups#job-j-4" },
      { check: "backups", status: "warn", label: "Hourly backup overdue", detail: "last ran 3h ago", fix: "/backups#job-j-hourly" },
    ]);
  });
});

describe("drillLines", () => {
  const drill = (outcome: string, at: Date, detail: string | null = null) => ({
    last: { outcome, verifiedAt: at, detail, name: "blog" },
    intervalMs: 7 * 86_400_000,
    now: NOW,
  });

  it("warns when nothing was ever drilled", () => {
    expect(drillLines({ last: null, intervalMs: 1, now: NOW })[0]).toMatchObject({ status: "warn", label: "No restore drill yet" });
  });

  it("passes a recent verified drill", () => {
    expect(drillLines(drill("verified", ago(86_400_000)))[0]).toMatchObject({ status: "pass", detail: "blog, 1d ago" });
  });

  it("warns on an old or unsupported drill", () => {
    expect(statuses(drillLines(drill("verified", ago(15 * 86_400_000))))).toEqual(["warn"]);
    expect(statuses(drillLines(drill("unsupported", ago(60_000))))).toEqual(["warn"]);
  });

  it("fails a failed drill with its first reason line", () => {
    expect(drillLines(drill("failed", ago(60_000), "\nrestore exited 1\nmore")).at(0)).toMatchObject({
      status: "fail",
      detail: "blog, 1m ago: restore exited 1",
    });
  });
});

describe("claimLines", () => {
  const STALE = 60 * 60_000;
  const claim = (over: Partial<Parameters<typeof claimLines>[0][number]> = {}) => ({
    key: "backup:job-claim:j1",
    jobName: "Nightly",
    noExpiry: false,
    ageMs: 60_000,
    running: false,
    ...over,
  });

  it("passes live claims", () => {
    expect(statuses(claimLines([claim(), claim({ ageMs: 2 * STALE, running: true })], STALE))).toEqual(["pass"]);
  });

  it("warns on claims with no expiry, for a deleted job or held past the stale window", () => {
    const lines = claimLines(
      [
        claim({ noExpiry: true }),
        claim({ key: "backup:job-claim:gone", jobName: null }),
        claim({ key: "backup:job-claim:j3", jobName: "Hourly", ageMs: 2 * STALE }),
      ],
      STALE,
    );
    expect(lines).toEqual([
      {
        check: "backups",
        status: "warn",
        label: "3 leftover backup claims",
        detail: "Nightly, backup:job-claim:gone and Hourly",
        fix: "docker exec vardo-redis redis-cli DEL backup:job-claim:j1 backup:job-claim:gone backup:job-claim:j3",
      },
    ]);
  });
});

describe("resourceLines", () => {
  const r = (name: string, status: "ok" | "warning" | "critical", percent: number) => ({ name, status, percent, detail: "x / y" });

  it("maps ok, warning and critical to pass, warn and fail", () => {
    expect(statuses(resourceLines([r("Memory", "ok", 40), r("Disk", "warning", 86)]))).toEqual(["pass", "warn"]);
    expect(resourceLines([r("Memory", "critical", 96.4), r("Disk", "ok", 10)])[0]).toMatchObject({
      status: "fail",
      label: "Memory 96% used",
      fix: "/metrics",
    });
  });

  it("warns on a missing reading", () => {
    expect(resourceLines([r("CPU", "ok", 1)]).map((l) => [l.status, l.label])).toEqual([
      ["warn", "No memory reading"],
      ["warn", "No disk reading"],
    ]);
  });
});

describe("oomLines", () => {
  it("passes without kills", () => {
    expect(statuses(oomLines([]))).toEqual(["pass"]);
  });

  it("fails host kills and warns limit kills", () => {
    const lines = oomLines([
      { appName: "db", hostKill: true },
      { appName: "api", hostKill: false },
    ]);
    expect(lines.map((l) => [l.status, l.label, l.detail])).toEqual([
      ["fail", "Host ran out of memory in the last hour", "Killed db"],
      ["warn", "1 app hit its memory limit in the last hour", "api"],
    ]);
  });
});

describe("updateLines", () => {
  const base = {
    version: "1.2.0 (abc1234)",
    mode: "auto",
    channel: "releases",
    hostCommand: "sudo vardo update",
    update: { hasUpdate: false, targetLabel: "1.2.0", commitsBehind: 0 },
    checkError: null,
    active: null,
    lastRun: null,
  };

  it("passes when up to date", () => {
    expect(updateLines(base)).toEqual([{ check: "update", status: "pass", label: "Up to date", detail: "1.2.0 (abc1234) · auto on releases" }]);
  });

  it("warns when behind, with the host command", () => {
    expect(updateLines({ ...base, update: { hasUpdate: true, targetLabel: "1.3.0", commitsBehind: 4 } })).toEqual([
      { check: "update", status: "warn", label: "Behind 1.3.0", detail: "On 1.2.0 (abc1234), 4 commits behind", fix: "sudo vardo update" },
    ]);
  });

  it("warns when updates are off or the check failed", () => {
    expect(updateLines({ ...base, mode: "off" }).map((l) => l.label)).toEqual(["Updates are off", "Up to date"]);
    expect(updateLines({ ...base, update: null, checkError: "rate limited" })).toEqual([
      { check: "update", status: "warn", label: "Couldn't check for updates", detail: "rate limited" },
    ]);
  });

  it("fails a failed last run and warns a rolled-back one", () => {
    expect(updateLines({ ...base, lastRun: { state: "failed", toLabel: "1.2.5", error: "verify failed" } })[0]).toMatchObject({
      status: "fail",
      label: "Last update to 1.2.5 failed",
      detail: "verify failed",
    });
    expect(statuses(updateLines({ ...base, lastRun: { state: "rolled-back", toLabel: "1.2.5" } }))).toEqual(["warn", "pass"]);
  });

  it("passes while an update runs", () => {
    expect(updateLines({ ...base, active: { toVersion: "1.3.0" } })).toEqual([
      { check: "update", status: "pass", label: "Update in progress", detail: "to 1.3.0" },
    ]);
  });
});

describe("attentionLines", () => {
  const row = (key: string, tone: AttentionRow["tone"], over: Partial<AttentionRow> = {}): AttentionRow => ({
    key,
    label: key,
    tone,
    items: [{ id: key, name: `${key}-item`, href: `/apps/${key}` }],
    ...over,
  });

  it("passes with nothing to report", () => {
    expect(attentionLines([{ name: "Acme", rows: [row("deploying", "activity")] }])).toEqual([
      { check: "attention", status: "pass", label: "Nothing needs attention" },
    ]);
  });

  it("maps error to fail and warning to warn, skipping rows the doctor already checks", () => {
    const lines = attentionLines([
      {
        name: "Acme",
        rows: [
          row("app-down", "error"),
          row("email-provider", "warning", { items: [{ id: "e", name: "No email provider", fix: { label: "Set up", href: "/admin/settings/email" } }] }),
          row("image-updates", "neutral"),
          row("backup-overdue", "error"),
        ],
      },
    ]);
    expect(lines).toEqual([
      { check: "attention", status: "fail", label: "app-down", detail: "app-down-item", fix: "/apps/app-down" },
      { check: "attention", status: "warn", label: "email-provider", detail: "No email provider", fix: "/admin/settings/email" },
    ]);
  });

  it("names the organization when there are several", () => {
    const lines = attentionLines([
      { name: "Acme", rows: [row("app-down", "error")] },
      { name: "Beta", rows: [] },
    ]);
    expect(lines[0].label).toBe("app-down in Acme");
  });

  it("shows a row every org repeats once, without an org", () => {
    const github = (): AttentionRow =>
      row("integration-permissions", "warning", {
        label: "Integrations",
        action: { label: "Check again", post: "/api/v1/organizations/x/integrations/check" },
        items: [
          {
            id: "integration:github:app",
            name: "GitHub App needs more permissions",
            fix: { label: "Add permissions on GitHub", href: "https://github.com/settings/apps/vardo-app/permissions", external: true },
          },
        ],
      });
    const lines = attentionLines([
      { name: "Homelab", rows: [github(), row("app-down", "error")] },
      { name: "Vardo", rows: [github(), row("app-down", "error", { items: [{ id: "other", name: "api", href: "/apps/api" }] })] },
    ]);
    expect(lines).toEqual([
      {
        check: "attention",
        status: "warn",
        label: "Integrations",
        detail: "GitHub App needs more permissions",
        fix: "https://github.com/settings/apps/vardo-app/permissions",
      },
      { check: "attention", status: "fail", label: "app-down in Homelab", detail: "app-down-item", fix: "/apps/app-down" },
      { check: "attention", status: "fail", label: "app-down in Vardo", detail: "api", fix: "/apps/api" },
    ]);
  });
});

describe("securityLines", () => {
  it("folds the probe guard summary into a pass line", () => {
    expect(securityLines({ summary: "3 probes turned away in the last day, 1 IP banned", activeBans: 2 })).toEqual([
      { check: "security", status: "pass", label: "Probe guard", detail: "3 probes turned away in the last day, 1 IP banned, 2 active bans" },
    ]);
  });
});
