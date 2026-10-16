// vardo_doctor's lines: each check's readings mapped to pass, warn and fail, and the runner that bounds them.

import type { AttentionRow } from "@/lib/ui/attention";
import { plural } from "@/lib/email/format";
import { formatDuration } from "@/lib/metrics/format";
import { formatRelativeTime } from "@/lib/ui/relative-time";
import { UPDATES_HREF } from "@/lib/attention/vardo-update-row";
import { probeAppName } from "@/lib/infra/instance-apps";
import { jobAnchor } from "@/components/backups/job-anchor";

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorLine = {
  check: string;
  status: DoctorStatus;
  label: string;
  detail?: string;
  /** A command or console path. */
  fix?: string;
};

export type DoctorCheck = {
  name: string;
  title: string;
  run: () => Promise<DoctorLine[]>;
  timeoutMs?: number;
};

const CHECK_TIMEOUT_MS = 5_000;

const NAMES_SHOWN = 3;

const WORKER_FIX = "vardo worker status";
const BACKUPS_HREF = "/backups";
const SYSTEM_BACKUP_HREF = "/admin/settings/backup";

const ago = (ms: number) => formatRelativeTime(-Math.max(0, ms), new Date(0));

/** "a, b, c and 2 more". */
export function names(list: string[], shown = NAMES_SHOWN): string {
  if (list.length <= shown) return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? "");
  return `${list.slice(0, shown).join(", ")} and ${list.length - shown} more`;
}

function line(check: string, status: DoctorStatus, label: string, extra: { detail?: string | null; fix?: string | null } = {}): DoctorLine {
  return { check, status, label, ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.fix ? { fix: extra.fix } : {}) };
}

class CheckTimeout extends Error {}

/** One check's lines. A throw or a timeout becomes a fail line. */
export async function runCheck(
  check: DoctorCheck,
  describe: (err: unknown) => string = (err) => (err instanceof Error ? err.message : String(err)),
): Promise<DoctorLine[]> {
  const timeoutMs = check.timeoutMs ?? CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = Promise.resolve().then(check.run);
  running.catch(() => {});
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeout()), timeoutMs);
      }),
    ]);
  } catch (err) {
    const detail = err instanceof CheckTimeout ? `Timed out after ${formatDuration(timeoutMs)}` : describe(err);
    return [line(check.name, "fail", `Couldn't check ${check.title}`, { detail })];
  } finally {
    clearTimeout(timer);
  }
}

const RANK: Record<DoctorStatus, number> = { fail: 0, warn: 1, pass: 2 };

export type DoctorReport = {
  status: DoctorStatus;
  counts: Record<DoctorStatus, number>;
  checkedAt: string;
  lines: DoctorLine[];
};

/** Every check's lines in check order, with the worst status and counts. */
export async function runDoctor(checks: DoctorCheck[], describe?: (err: unknown) => string, now = new Date()): Promise<DoctorReport> {
  const lines = (await Promise.all(checks.map((c) => runCheck(c, describe)))).flat();
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const l of lines) counts[l.status]++;
  const status = lines.reduce<DoctorStatus>((worst, l) => (RANK[l.status] < RANK[worst] ? l.status : worst), "pass");
  return { status, counts, checkedAt: now.toISOString(), lines };
}

/** "FAIL  Worker down · last beat 4 min ago" with the fix on the next line. */
export function formatReport(report: DoctorReport): string {
  const out = report.lines.map((l) => {
    const head = `${l.status.toUpperCase().padEnd(4)}  ${l.label}${l.detail ? ` · ${l.detail}` : ""}`;
    return l.fix ? `${head}\n      Fix: ${l.fix}` : head;
  });
  const { pass, warn, fail } = report.counts;
  out.push("", `${plural(pass, "pass", "passes")}, ${plural(warn, "warning")}, ${plural(fail, "failure")}`);
  return out.join("\n");
}

export type WorkerReading = {
  expected: boolean;
  workerReady: boolean;
  workerAt: Date | null;
  watchdogSilent: boolean;
  now: Date;
  freshMs: number;
};

export function workerLines(r: WorkerReading): DoctorLine[] {
  const lines: DoctorLine[] = [];
  const beat = r.workerAt ? r.now.getTime() - r.workerAt.getTime() : null;
  if (!r.expected) lines.push(line("worker", "pass", "Loops run in the console", { detail: "No worker expected" }));
  else if (r.workerReady) lines.push(line("worker", "pass", "Worker up", { detail: beat === null ? null : `last beat ${ago(beat)}` }));
  else if (beat !== null && beat < r.freshMs) {
    lines.push(line("worker", "warn", "Worker booting or draining", { detail: `last beat ${ago(beat)}`, fix: WORKER_FIX }));
  } else {
    lines.push(line("worker", "fail", "Worker down", { detail: beat === null ? "Never seen" : `last beat ${ago(beat)}`, fix: WORKER_FIX }));
  }
  if (r.watchdogSilent) {
    lines.push(line("worker", "warn", "Watchdog stopped checking", { fix: "docker ps --filter name=vardo-watchdog" }));
  }
  return lines;
}

export type ServiceReading = { name: string; status: "healthy" | "unhealthy" | "unconfigured"; error?: string; logsHref?: string };

export type ProbedApp = { id: string; name: string; parentAppId: string | null };

/** Ids and names behind the failed probes, compose children included. */
function failedProbeSubjects(failed: ServiceReading[], apps: ProbedApp[]): Set<string> {
  const subjects = new Set(failed.map((s) => s.name));
  const appNames = new Set(failed.map((s) => probeAppName(s.name)).filter((n): n is string => n !== null));
  const ids = new Set(apps.filter((a) => appNames.has(a.name)).map((a) => a.id));
  for (const a of apps) if (ids.has(a.id) || (a.parentAppId && ids.has(a.parentAppId))) subjects.add(a.id);
  return subjects;
}

/** Probed services, then the core service rows the console already raises, minus items a failed probe already reported. */
export function serviceLines(services: ServiceReading[], coreRows: AttentionRow[], apps: ProbedApp[] = []): DoctorLine[] {
  const lines: DoctorLine[] = [];
  const healthy = services.filter((s) => s.status === "healthy").map((s) => s.name);
  const failed = services.filter((s) => s.status === "unhealthy");
  for (const s of failed) lines.push(line("services", "fail", `${s.name} down`, { detail: s.error, fix: s.logsHref }));
  const probed = failedProbeSubjects(failed, apps);
  const rows = coreRows.map((row) => ({ ...row, items: row.items.filter((i) => !probed.has(i.id) && !probed.has(i.name)) }));
  lines.push(...attentionRowLines("services", rows));
  if (healthy.length > 0) lines.unshift(line("services", "pass", `${plural(healthy.length, "service")} healthy`, { detail: healthy.join(", ") }));
  return lines;
}

export type DeployQueueReading = {
  /** Running deploys whose lease lapsed and that no sweep reclaimed. */
  pastLease: number;
  oldestPastLeaseMs: number | null;
  waitingOnWorker: number;
};

export function deployQueueLines(r: DeployQueueReading): DoctorLine[] {
  const lines: DoctorLine[] = [];
  if (r.pastLease > 0) {
    lines.push(
      line("deploys", "fail", `${plural(r.pastLease, "deploy")} past ${r.pastLease === 1 ? "its" : "their"} lease`, {
        detail: r.oldestPastLeaseMs === null ? null : `oldest lapsed ${ago(r.oldestPastLeaseMs)}`,
        fix: WORKER_FIX,
      }),
    );
  }
  if (r.waitingOnWorker > 0) {
    lines.push(line("deploys", "fail", `${plural(r.waitingOnWorker, "deploy")} waiting on a missing worker`, { fix: WORKER_FIX }));
  }
  if (lines.length === 0) lines.push(line("deploys", "pass", "No stuck deploys"));
  return lines;
}

export type SystemBackupReading = {
  job: { enabled: boolean; target: { name: string; type: string } | null } | null;
};

export function backupStorageLines(r: SystemBackupReading): DoctorLine[] {
  if (!r.job) return [line("backups", "fail", "Vardo's database has no backup job", { fix: SYSTEM_BACKUP_HREF })];
  if (!r.job.target) return [line("backups", "fail", "No storage for Vardo's database backups", { fix: SYSTEM_BACKUP_HREF })];
  if (!r.job.enabled) return [line("backups", "warn", "Vardo's database backup is off", { fix: SYSTEM_BACKUP_HREF })];
  return [line("backups", "pass", "Backup storage set", { detail: `${r.job.target.name} (${r.job.target.type})` })];
}

export type BackupJobsReading = {
  enabledJobs: number;
  failing: string[];
  overdue: { id: string; name: string; since: Date; neverRan: boolean }[];
  now: Date;
};

export function backupJobLines(r: BackupJobsReading): DoctorLine[] {
  const lines: DoctorLine[] = [];
  if (r.failing.length > 0) {
    lines.push(line("backups", "fail", `${plural(r.failing.length, "backup job")} failing`, { detail: names(r.failing), fix: BACKUPS_HREF }));
  }
  for (const o of [...r.overdue].sort((a, b) => a.since.getTime() - b.since.getTime())) {
    lines.push(
      line("backups", "warn", `${o.name} backup overdue`, {
        detail: o.neverRan ? "never ran" : `last ran ${ago(r.now.getTime() - o.since.getTime())}`,
        fix: `${BACKUPS_HREF}#${jobAnchor(o.id)}`,
      }),
    );
  }
  if (lines.length === 0) {
    lines.push(
      r.enabledJobs === 0
        ? line("backups", "warn", "No backup jobs enabled", { fix: BACKUPS_HREF })
        : line("backups", "pass", `${plural(r.enabledJobs, "backup job")} on schedule`),
    );
  }
  return lines;
}

export type DrillReading = {
  last: { outcome: string | null; verifiedAt: Date; detail: string | null; name: string } | null;
  intervalMs: number;
  now: Date;
};

export function drillLines(r: DrillReading): DoctorLine[] {
  if (!r.last) return [line("backups", "warn", "No restore drill yet", { fix: BACKUPS_HREF })];
  const age = r.now.getTime() - r.last.verifiedAt.getTime();
  const when = `${r.last.name}, ${ago(age)}`;
  if (r.last.outcome === "failed") {
    const reason = r.last.detail?.split("\n").find((l) => l.trim())?.trim();
    return [line("backups", "fail", "Last restore drill failed", { detail: reason ? `${when}: ${reason}` : when, fix: BACKUPS_HREF })];
  }
  if (r.last.outcome !== "verified") return [line("backups", "warn", "Last restore drill couldn't verify", { detail: when, fix: BACKUPS_HREF })];
  if (age > r.intervalMs * 2) return [line("backups", "warn", "Last restore drill is old", { detail: when, fix: BACKUPS_HREF })];
  return [line("backups", "pass", "Last restore drill passed", { detail: when })];
}

export type ClaimReading = { key: string; jobName: string | null; noExpiry: boolean; ageMs: number | null; running: boolean };

/** A claim with no expiry, for a deleted job, or held past `staleMs` with no run in flight. */
export function isLeftoverClaim(c: ClaimReading, staleMs: number): boolean {
  return c.noExpiry || c.jobName === null || (!c.running && c.ageMs !== null && c.ageMs > staleMs);
}

export function claimLines(claims: ClaimReading[], staleMs: number): DoctorLine[] {
  const leftover = claims.filter((c) => isLeftoverClaim(c, staleMs));
  if (leftover.length === 0) return [line("backups", "pass", "No leftover backup claims")];
  return [
    line("backups", "warn", plural(leftover.length, "leftover backup claim"), {
      detail: names(leftover.map((c) => c.jobName ?? c.key)),
      fix: `docker exec vardo-redis redis-cli DEL ${leftover.map((c) => c.key).join(" ")}`,
    }),
  ];
}

export type ResourceReading = { name: string; percent: number; status: "ok" | "warning" | "critical"; detail: string };

/** Memory and disk as the console reads them. A missing reading warns. */
export function resourceLines(resources: ResourceReading[]): DoctorLine[] {
  return ["Memory", "Disk"].map((name) => {
    const r = resources.find((x) => x.name === name);
    if (!r) return line("resources", "warn", `No ${name.toLowerCase()} reading`, { detail: name === "Memory" ? "The collector has no sample" : null });
    const status: DoctorStatus = r.status === "critical" ? "fail" : r.status === "warning" ? "warn" : "pass";
    return line("resources", status, `${name} ${Math.round(r.percent)}% used`, { detail: r.detail, fix: status === "pass" ? null : "/metrics" });
  });
}

export type OomReading = { appName: string; hostKill: boolean };

export function oomLines(records: OomReading[]): DoctorLine[] {
  const host = records.filter((r) => r.hostKill).map((r) => r.appName);
  const limit = records.filter((r) => !r.hostKill).map((r) => r.appName);
  const lines: DoctorLine[] = [];
  if (host.length > 0) lines.push(line("resources", "fail", "Host ran out of memory in the last hour", { detail: `Killed ${names(host)}`, fix: "/metrics" }));
  if (limit.length > 0) lines.push(line("resources", "warn", `${plural(limit.length, "app")} hit ${limit.length === 1 ? "its" : "their"} memory limit in the last hour`, { detail: names(limit) }));
  if (lines.length === 0) lines.push(line("resources", "pass", "No OOM kills in the last hour"));
  return lines;
}

export type UpdateReading = {
  version: string;
  mode: string;
  channel: string;
  hostCommand: string;
  update: { hasUpdate: boolean; targetLabel: string; commitsBehind: number | null } | null;
  checkError: string | null;
  active: { toVersion: string | null } | null;
  lastRun: { state: string; toLabel: string; error?: string } | null;
};

export function updateLines(r: UpdateReading): DoctorLine[] {
  if (r.active) return [line("update", "pass", "Update in progress", { detail: r.active.toVersion ? `to ${r.active.toVersion}` : null })];
  const lines: DoctorLine[] = [];
  if (r.lastRun?.state === "failed" || r.lastRun?.state === "rollback-failed") {
    lines.push(line("update", "fail", `Last update to ${r.lastRun.toLabel} failed`, { detail: r.lastRun.error, fix: UPDATES_HREF }));
  } else if (r.lastRun?.state === "rolled-back") {
    lines.push(line("update", "warn", `Last update to ${r.lastRun.toLabel} rolled back`, { detail: r.lastRun.error, fix: UPDATES_HREF }));
  }
  if (r.mode === "off") lines.push(line("update", "warn", "Updates are off", { fix: UPDATES_HREF }));
  if (r.checkError) lines.push(line("update", "warn", "Couldn't check for updates", { detail: r.checkError }));
  if (r.update?.hasUpdate) {
    const n = r.update.commitsBehind;
    lines.push(
      line("update", "warn", `Behind ${r.update.targetLabel}`, {
        detail: `On ${r.version}${n ? `, ${plural(n, "commit")} behind` : ""}`,
        fix: r.hostCommand,
      }),
    );
  } else if (!r.checkError) {
    lines.push(line("update", "pass", "Up to date", { detail: `${r.version} · ${r.mode} on ${r.channel}` }));
  }
  return lines;
}

/** Attention rows the doctor's own checks already report. */
export const COVERED_ATTENTION_KEYS = new Set(["backup-failed", "backup-overdue", "backup-system-db"]);

function rowFix(row: AttentionRow): string | null {
  if (row.action && "href" in row.action) return row.action.href;
  for (const item of row.items) {
    if (item.fix && "href" in item.fix && item.fix.href) return item.fix.href;
  }
  return row.items.find((i) => i.href && !i.external)?.href ?? null;
}

const reportedRows = (rows: AttentionRow[]) =>
  rows.filter((row) => (row.tone === "error" || row.tone === "warning") && row.items.length > 0 && !COVERED_ATTENTION_KEYS.has(row.key));

function attentionRowLine(check: string, row: AttentionRow): DoctorLine {
  return line(check, row.tone === "error" ? "fail" : "warn", row.label, { detail: names(row.items.map((i) => i.name)), fix: rowFix(row) });
}

/** Error rows fail and warning rows warn. Everything else is left out. */
export function attentionRowLines(check: string, rows: AttentionRow[]): DoctorLine[] {
  return reportedRows(rows).map((row) => attentionRowLine(check, row));
}

/** One line per row, merged across orgs when the key and line match. Names its orgs unless every org with rows has it. */
export function attentionLines(orgs: { name: string; rows: AttentionRow[] }[]): DoctorLine[] {
  const merged = new Map<string, { line: DoctorLine; orgs: string[] }>();
  let withRows = 0;
  for (const o of orgs) {
    const rows = reportedRows(o.rows);
    if (rows.length > 0) withRows++;
    for (const row of rows) {
      const l = attentionRowLine("attention", row);
      const id = JSON.stringify([row.key, l.status, l.label, l.detail, l.fix]);
      const seen = merged.get(id);
      if (seen) seen.orgs.push(o.name);
      else merged.set(id, { line: l, orgs: [o.name] });
    }
  }
  const lines = [...merged.values()].map(({ line: l, orgs: seenIn }) =>
    orgs.length > 1 && (seenIn.length === 1 || seenIn.length < withRows) ? { ...l, label: `${l.label} in ${names(seenIn, 2)}` } : l,
  );
  return lines.length > 0 ? lines : [line("attention", "pass", "Nothing needs attention")];
}

export type SecurityReading = { summary: string; activeBans: number };

export function securityLines(r: SecurityReading): DoctorLine[] {
  return [line("security", "pass", "Probe guard", { detail: `${r.summary}, ${plural(r.activeBans, "active ban")}` })];
}
