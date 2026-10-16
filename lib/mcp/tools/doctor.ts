import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, count, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backups, deployments } from "@/lib/db/schema";
import { ADMIN_FORBIDDEN_MESSAGE } from "@/lib/auth/admin-error";
import { getSystemHealth, sanitizeError, type SystemHealth } from "@/lib/config/health";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { getInfrastructureSnapshot } from "@/lib/attention/infrastructure";
import { infrastructureRows } from "@/lib/attention/infrastructure-rows";
import { buildAttentionRows } from "@/lib/attention/rows";
import { sharedOomKills } from "@/lib/alerts/oom";
import { DRILL_INTERVAL_MS } from "@/lib/backups/drill-schedule";
import { STALE_RUN_MS } from "@/lib/backups/engine";
import { jobClaimHolder, jobClaimKey } from "@/lib/backups/job-claim";
import { overdueBackupJobs } from "@/lib/backups/staleness";
import { readSystemBackupJob } from "@/lib/backups/system-storage";
import { LEASE_TTL_MS } from "@/lib/deploy/queue";
import { deploysWaitingForWorker } from "@/lib/deploy/waiting";
import { backupJobLabel } from "@/lib/email/format";
import { guardHistory } from "@/lib/probe-guard/history";
import { listActiveBans } from "@/lib/probe-guard/bans";
import { guardSummary } from "@/lib/probe-guard/summary";
import { redis } from "@/lib/redis";
import { getUpdateStatus } from "@/lib/self-update/status";
import { WORKER_FRESH_MS, workerExpected } from "@/lib/worker/mode";
import { readHostHeartbeats, watchdogSilent } from "@/lib/worker/watch";
import type { McpAuthContext } from "../auth";
import { accessibleOrgIds, canAdminInstance, orgLabels } from "../scope";
import { failure } from "./result";
import {
  attentionLines,
  backupJobLines,
  backupStorageLines,
  claimLines,
  deployQueueLines,
  drillLines,
  formatReport,
  oomLines,
  resourceLines,
  runDoctor,
  securityLines,
  serviceLines,
  updateLines,
  workerLines,
  type ClaimReading,
  type DoctorCheck,
  type DoctorLine,
} from "./doctor-checks";

const SLOW_CHECK_MS = 10_000;
const ACTIVE_BAN_COUNT_CAP = 500;

async function workerCheck(): Promise<DoctorLine[]> {
  const beats = await readHostHeartbeats();
  return workerLines({
    expected: workerExpected(),
    workerReady: beats.workerReady,
    workerAt: beats.workerAt,
    watchdogSilent: watchdogSilent(beats.watchdogAt, beats.now),
    now: beats.now,
    freshMs: WORKER_FRESH_MS,
  });
}

async function servicesCheck(health: () => Promise<SystemHealth>): Promise<DoctorLine[]> {
  const [{ services }, snapshot] = await Promise.all([health(), getInfrastructureSnapshot()]);
  return serviceLines(services, infrastructureRows(snapshot, { canLinkToAdmin: true }), snapshot.apps);
}

async function deployQueueCheck(): Promise<DoctorLine[]> {
  const [[lapsed], waitingOnWorker] = await Promise.all([
    db
      .select({
        n: count(),
        oldestMs: sql<number | null>`(extract(epoch from now() - min(${deployments.leaseExpiresAt})) * 1000)::float8`,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.status, "running"),
          lt(deployments.leaseExpiresAt, sql`now() - ${LEASE_TTL_MS}::int * interval '1 millisecond'`),
        ),
      ),
    deploysWaitingForWorker(),
  ]);
  return deployQueueLines({
    pastLease: lapsed?.n ?? 0,
    oldestPastLeaseMs: lapsed?.oldestMs == null ? null : Number(lapsed.oldestMs),
    waitingOnWorker,
  });
}

async function backupJobsCheck(): Promise<DoctorLine[]> {
  if (!(await isFeatureEnabledAsync("backups"))) return [{ check: "backups", status: "warn", label: "Backups are off" }];

  const now = new Date();
  const [{ job }, jobs] = await Promise.all([
    readSystemBackupJob(),
    db.query.backupJobs.findMany({
      columns: { id: true, name: true, schedule: true, enabled: true, lastRunAt: true, createdAt: true },
      with: { backups: { orderBy: (b, { desc }) => [desc(b.startedAt)], limit: 1, columns: { status: true } } },
    }),
  ]);
  const enabled = jobs.filter((j) => j.enabled);
  return [
    ...backupStorageLines({ job: job && { enabled: job.enabled, target: job.target } }),
    ...backupJobLines({
      enabledJobs: enabled.length,
      failing: enabled.filter((j) => j.backups[0]?.status === "failed").map((j) => backupJobLabel(j.name)),
      overdue: overdueBackupJobs(jobs, now).map((o) => ({ id: o.job.id, name: backupJobLabel(o.job.name), since: o.since, neverRan: o.neverRan })),
      now,
    }),
  ];
}

async function drillCheck(): Promise<DoctorLine[]> {
  if (!(await isFeatureEnabledAsync("backups"))) return [];
  const last = await db.query.backups.findFirst({
    where: isNotNull(backups.verifiedAt),
    orderBy: [desc(backups.verifiedAt)],
    columns: { verifiedAt: true, verifyOutcome: true, verifyDetail: true, appName: true, jobName: true },
  });
  return drillLines({
    last: last?.verifiedAt
      ? {
          outcome: last.verifyOutcome,
          verifiedAt: last.verifiedAt,
          detail: last.verifyDetail,
          name: last.appName ?? (last.jobName ? backupJobLabel(last.jobName) : "Vardo database"),
        }
      : null,
    intervalMs: DRILL_INTERVAL_MS,
    now: new Date(),
  });
}

/** Every `backup:job-claim:*` key with its job, age, expiry and whether a run is in flight. */
async function readJobClaims(): Promise<ClaimReading[]> {
  const prefix = jobClaimKey("");
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length === 0) return [];

  const jobIds = keys.map((k) => k.slice(prefix.length));
  const [ttls, holders, jobs, running] = await Promise.all([
    Promise.all(keys.map((k) => redis.pttl(k))),
    Promise.all(jobIds.map((id) => jobClaimHolder(id))),
    db.query.backupJobs.findMany({ where: inArray(backupJobs.id, jobIds), columns: { id: true, name: true } }),
    db
      .selectDistinct({ jobId: backups.jobId })
      .from(backups)
      .where(and(inArray(backups.jobId, jobIds), inArray(backups.status, ["pending", "running"]))),
  ]);
  const jobName = new Map(jobs.map((j) => [j.id, backupJobLabel(j.name)]));
  const inFlight = new Set(running.map((r) => r.jobId));
  const now = Date.now();
  return keys.map((key, i) => ({
    key,
    jobName: jobName.get(jobIds[i]) ?? null,
    noExpiry: ttls[i] === -1,
    ageMs: holders[i] ? now - holders[i].startedAt.getTime() : null,
    running: inFlight.has(jobIds[i]),
  }));
}

async function claimsCheck(): Promise<DoctorLine[]> {
  if (!(await isFeatureEnabledAsync("backups"))) return [];
  return claimLines(await readJobClaims(), STALE_RUN_MS);
}

async function resourcesCheck(health: () => Promise<SystemHealth>): Promise<DoctorLine[]> {
  const [{ resources }, kills] = await Promise.all([health(), sharedOomKills(Date.now())]);
  return [
    ...resourceLines(resources),
    ...oomLines(kills),
  ];
}

async function updateCheck(): Promise<DoctorLine[]> {
  const s = await getUpdateStatus();
  return updateLines({
    version: s.current.version,
    mode: s.policy.mode,
    channel: s.channel,
    hostCommand: s.hostCommand,
    update: s.update && { hasUpdate: s.update.hasUpdate, targetLabel: s.update.targetLabel, commitsBehind: s.update.commitsBehind },
    checkError: s.checkError?.message ?? null,
    active: s.active && { toVersion: s.active.toVersion ?? null },
    lastRun: s.run && { state: s.run.state, toLabel: s.run.toLabel, error: s.run.error },
  });
}

async function attentionCheck(context: McpAuthContext): Promise<DoctorLine[]> {
  const orgIds = await accessibleOrgIds(context, "org.view");
  const labels = await orgLabels(orgIds);
  const orgs = await Promise.all(
    orgIds.map(async (id) => ({ name: labels.get(id)?.name ?? id, rows: await buildAttentionRows(id, { isAppAdmin: true }) })),
  );
  return attentionLines(orgs);
}

async function securityCheck(): Promise<DoctorLine[]> {
  const [history, active] = await Promise.all([guardHistory({ range: "24h" }), listActiveBans({ limit: ACTIVE_BAN_COUNT_CAP })]);
  return securityLines({ summary: guardSummary(history.stats, "in the last day"), activeBans: active.length });
}

/** The checks one doctor run makes. Services and resources share one health read. */
export function doctorChecks(context: McpAuthContext): DoctorCheck[] {
  let healthRead: Promise<SystemHealth> | undefined;
  const health = () => (healthRead ??= getSystemHealth({ isAdmin: async () => true }));
  return [
    { name: "worker", title: "the worker", run: workerCheck },
    { name: "services", title: "services", run: () => servicesCheck(health), timeoutMs: SLOW_CHECK_MS },
    { name: "deploys", title: "the deploy queue", run: deployQueueCheck },
    { name: "backups", title: "backup jobs", run: backupJobsCheck },
    { name: "backups", title: "restore drills", run: drillCheck },
    { name: "backups", title: "backup claims", run: claimsCheck },
    { name: "resources", title: "memory and disk", run: () => resourcesCheck(health), timeoutMs: SLOW_CHECK_MS },
    { name: "update", title: "updates", run: updateCheck, timeoutMs: SLOW_CHECK_MS },
    { name: "attention", title: "attention items", run: () => attentionCheck(context), timeoutMs: SLOW_CHECK_MS },
    { name: "security", title: "the probe guard", run: securityCheck },
  ];
}

const describeError = (err: unknown) => sanitizeError(err instanceof Error ? err.message : String(err));

/** Instance health as pass, warn and fail lines. Registered only for a token with the admin scope. */
export function registerDoctor(server: McpServer, context: McpAuthContext) {
  if (!context.adminScope) return;

  server.tool(
    "vardo_doctor",
    "Check this instance in one pass and get pass, warn and fail lines, each with its fix where there's one: worker, services, deploy queue, backups and restore drills, memory, disk and OOM kills, updates, attention items and the probe guard. Needs a token with the admin scope.",
    {},
    async () => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);

      const report = await runDoctor(doctorChecks(context), describeError);
      return {
        content: [
          { type: "text" as const, text: formatReport(report) },
          { type: "text" as const, text: JSON.stringify(report, null, 2) },
        ],
        structuredContent: report,
      };
    },
  );
}
