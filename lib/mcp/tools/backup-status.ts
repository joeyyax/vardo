import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, backups } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { orgBackupScope } from "@/lib/backups/org-backup";
import { getNextRun } from "@/lib/backups/next-run";
import { readSystemBackupJob } from "@/lib/backups/system-storage";
import { redactSecrets } from "@/lib/redact";
import { getOrgTimeZone } from "@/lib/time-zone-settings";
import type { McpAuthContext } from "../auth";
import { accessDenied, accessibleOrgIds, canAdminInstance, orgLabels } from "../scope";
import { clampLimit, failure, iso, limitArg, text } from "./result";

const BACKUPS_OFF = "Backups are turned off on this instance";
const ERROR_TAIL = 300;
const APPS_PER_JOB = 10;
const RECENT_RUNS = 10;

const BACKUP_STATUSES = ["pending", "running", "success", "failed", "skipped", "pruned"] as const;

/** The last non-empty line of a failed run's log, scrubbed. */
function lastLine(tail: string | null): string | null {
  const line = tail?.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return line ? redactSecrets(line) : null;
}

function nextRunOf(job: { enabled: boolean; schedule: string }, timeZone?: string): string | null {
  return job.enabled ? iso(getNextRun(job.schedule, timeZone)) : null;
}

export function registerBackupStatusTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_backup_jobs",
    "List backup jobs per organization with schedule, target name and type, apps, enabled flag, last run outcome and time and next run. Admin tokens also get the system database backup job. Pass organizationId for one org.",
    {
      organizationId: z.string().optional().describe("Only this organization"),
      limit: limitArg,
    },
    async ({ organizationId, limit }) => {
      if (!(await isFeatureEnabledAsync("backups"))) return failure(BACKUPS_OFF);

      const reachable = await accessibleOrgIds(context, "backup.view");
      const orgIds = organizationId ? reachable.filter((id) => id === organizationId) : reachable;
      if (organizationId && orgIds.length === 0) return accessDenied("Organization");

      const cap = clampLimit(limit);
      const labels = await orgLabels(orgIds);

      const organizations = await Promise.all(
        orgIds.map(async (orgId) => {
          const [jobs, timeZone] = await Promise.all([
            db.query.backupJobs.findMany({
              where: eq(backupJobs.organizationId, orgId),
              with: {
                target: { columns: { name: true, type: true } },
                backupJobApps: { with: { app: { columns: { id: true, name: true, displayName: true } } } },
                backups: {
                  orderBy: (b, { desc }) => [desc(b.startedAt)],
                  limit: RECENT_RUNS,
                  columns: { status: true, startedAt: true },
                },
              },
              orderBy: (j, { asc }) => [asc(j.name)],
              limit: cap,
            }),
            getOrgTimeZone(orgId),
          ]);

          return {
            organization: labels.get(orgId) ?? { id: orgId },
            jobs: jobs.map((job) => {
              const [latest] = job.backups;
              return {
                id: job.id,
                name: job.name,
                schedule: job.schedule,
                timeZone,
                enabled: job.enabled,
                nightly: job.nightly,
                target: job.target ? { name: job.target.name, type: job.target.type } : null,
                appCount: job.backupJobApps.length,
                apps: job.backupJobApps.slice(0, APPS_PER_JOB).map((a) => ({ id: a.app.id, name: a.app.displayName })),
                lastRunAt: iso(job.lastRunAt),
                lastRun: latest ? { status: latest.status, at: iso(latest.startedAt) } : null,
                failuresInLast10: job.backups.filter((b) => b.status === "failed").length,
                nextRunAt: nextRunOf(job, timeZone),
              };
            }),
          };
        }),
      );

      let system: unknown;
      if (!organizationId && (await canAdminInstance(context))) {
        const { job, history } = await readSystemBackupJob();
        const [latest] = history;
        system = job
          ? {
              id: job.id,
              name: job.name,
              schedule: job.schedule,
              enabled: job.enabled,
              target: job.target ? { name: job.target.name, type: job.target.type } : null,
              lastRunAt: iso(job.lastRunAt),
              lastRun: latest ? { status: latest.status, at: iso(latest.startedAt), encrypted: latest.encrypted } : null,
              failuresInLast20: history.filter((b) => b.status === "failed").length,
              nextRunAt: nextRunOf(job),
            }
          : null;
      }

      return text({ organizations, ...(system !== undefined && { systemDatabaseJob: system }) });
    },
  );

  server.tool(
    "vardo_list_backups",
    "List backup history, newest first, with status, size, app, job, trigger, encryption, restore-test result and the last log line of failures. Filter by appId, jobId or status. Never returns storage paths or credentials.",
    {
      appId: z.string().optional().describe("Only this app's backups"),
      jobId: z.string().optional().describe("Only this job's backups"),
      status: z.enum(BACKUP_STATUSES).optional().describe("Only backups in this status"),
      limit: limitArg,
    },
    async ({ appId, jobId, status, limit }) => {
      if (!(await isFeatureEnabledAsync("backups"))) return failure(BACKUPS_OFF);

      const orgIds = await accessibleOrgIds(context, "backup.view");
      const cap = clampLimit(limit);
      const labels = await orgLabels(orgIds);

      const perOrg = await Promise.all(
        orgIds.map(async (orgId) => {
          const filters = [orgBackupScope(orgId)];
          if (appId) filters.push(eq(backups.appId, appId));
          if (jobId) filters.push(eq(backups.jobId, jobId));
          if (status) filters.push(eq(backups.status, status));

          const rows = await db
            .select({
              id: backups.id,
              jobId: backups.jobId,
              jobName: backups.jobName,
              appId: backups.appId,
              appName: backups.appName,
              volumeName: backups.volumeName,
              status: backups.status,
              sizeBytes: backups.sizeBytes,
              trigger: backups.trigger,
              encrypted: backups.encrypted,
              verifiedAt: backups.verifiedAt,
              verifyOutcome: backups.verifyOutcome,
              startedAt: backups.startedAt,
              finishedAt: backups.finishedAt,
              logTail: sql<string | null>`case when ${backups.status} = 'failed' then right(${backups.log}, ${ERROR_TAIL}) end`,
            })
            .from(backups)
            .where(and(...filters))
            .orderBy(desc(backups.startedAt))
            .limit(cap);

          const organization = labels.get(orgId) ?? { id: orgId, name: orgId, slug: orgId };
          return rows.map(({ logTail, ...row }) => ({
            ...row,
            startedAt: iso(row.startedAt),
            finishedAt: iso(row.finishedAt),
            verifiedAt: iso(row.verifiedAt),
            error: lastLine(logTail),
            ...(context.crossOrg && { organization }),
          }));
        }),
      );

      const merged = perOrg.flat().sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
      return text({ backups: merged.slice(0, cap), count: Math.min(merged.length, cap) });
    },
  );
}
