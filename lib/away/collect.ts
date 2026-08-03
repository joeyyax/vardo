// ---------------------------------------------------------------------------
// "While you were away" — collection
//
// Reads the durable operational tables, turns rows into facts, and counts each
// subject's history from before the window so the classifier can tell a
// first-ever failure from a familiar one. Every source is independently
// try/caught: one unreadable source is reported, never silently dropped.
// ---------------------------------------------------------------------------

import { and, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  activities,
  apps,
  appSecurityScans,
  backupJobs,
  backups,
  cronJobRuns,
  cronJobs,
  deployments,
  domainChecks,
  domains,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";

import { deriveAppStateFacts, type AwayAppRow } from "./app-state";
import { baselineKey } from "./classify";
import type { AwayBaselines, AwayFact, AwayFamily, AwayInput } from "./types";

const log = logger.child("away");

/** How far back baselines look. Long enough to establish a habit, short enough to stay cheap. */
export const BASELINE_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/** Audit actions with a better source, or too routine to report. */
const IGNORED_ACTIONS = new Set([
  "deployment.started",
  "deployment.succeeded",
  "deployment.failed",
  "deployment.cancelled",
  "deployment.rolled_back",
  "deployment.instant_rollback",
  "volume.sync",
]);

const ALERT_STATE_KEY = "system_alert_state";

const ALERT_KIND: Record<string, string> = {
  "cert-expiring": "system.cert-expiring",
  "disk-space": "system.disk-alert",
  "service-degraded": "system.service-down",
  "host-restarted": "system.host-restarted",
  "update-available": "system.update-available",
};

type Counter = Map<string, { successes: number; failures: number }>;

function bump(
  counts: Counter,
  family: AwayFamily,
  subjectId: string,
  outcome: "successes" | "failures",
  n = 1,
): void {
  const key = baselineKey(family, subjectId);
  const entry = counts.get(key) ?? { successes: 0, failures: 0 };
  entry[outcome] += n;
  counts.set(key, entry);
}

/** Runs a source, recording its name rather than its rows when it throws. */
async function source<T>(
  name: string,
  unavailable: string[],
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.error(`Source "${name}" failed:`, err instanceof Error ? err.message : err);
    unavailable.push(name);
    return fallback;
  }
}

export type CollectOptions = {
  orgId: string;
  userId: string;
  since: Date;
  now?: Date;
};

/**
 * Gather everything that happened to one org between `since` and now.
 * Returns classifier input — no tiering decisions are made here.
 */
export async function collectAway(opts: CollectOptions): Promise<AwayInput> {
  const { orgId, userId, since } = opts;
  const now = opts.now ?? new Date();
  const baselineFrom = new Date(now.getTime() - BASELINE_LOOKBACK_MS);

  const unavailable: string[] = [];
  const facts: AwayFact[] = [];
  const counts: Counter = new Map();

  const orgApps = await source(
    "apps",
    unavailable,
    () =>
      db.query.apps.findMany({
        where: eq(apps.organizationId, orgId),
        columns: {
          id: true,
          name: true,
          displayName: true,
          status: true,
          parked: true,
          containerStartedAt: true,
          updatedAt: true,
        },
      }),
    [] as AwayAppRow[],
  );

  const appIds = orgApps.map((a) => a.id);
  const appName = new Map(orgApps.map((a) => [a.id, a.displayName]));
  const appSlug = new Map(orgApps.map((a) => [a.id, a.name]));

  await Promise.all([
    // ---- Deploys -----------------------------------------------------------
    source(
      "deployments",
      unavailable,
      async () => {
        if (appIds.length === 0) return;
        const rows = await db
          .select({
            appId: deployments.appId,
            status: deployments.status,
            startedAt: deployments.startedAt,
          })
          .from(deployments)
          .where(
            and(
              inArray(deployments.appId, appIds),
              gte(deployments.startedAt, baselineFrom),
            ),
          );

        for (const row of rows) {
          const name = appName.get(row.appId) ?? row.appId;
          const href = `/apps/${appSlug.get(row.appId) ?? row.appId}`;
          const inWindow = row.startedAt >= since;

          if (row.status === "success") {
            if (inWindow) {
              facts.push({
                kind: "deploy.success",
                family: "deploy",
                subjectId: row.appId,
                subjectName: name,
                at: row.startedAt,
                outcome: "success",
                href,
              });
            } else {
              bump(counts, "deploy", row.appId, "successes");
            }
          } else if (row.status === "failed") {
            if (inWindow) {
              facts.push({
                kind: "deploy.failed",
                family: "deploy",
                subjectId: row.appId,
                subjectName: name,
                at: row.startedAt,
                outcome: "failure",
                href,
              });
            } else {
              bump(counts, "deploy", row.appId, "failures");
            }
          } else if (row.status === "rolled_back" && inWindow) {
            facts.push({
              kind: "deploy.rollback",
              family: "deploy",
              subjectId: row.appId,
              subjectName: name,
              at: row.startedAt,
              outcome: "failure",
              detail: "Rolled back",
              href,
            });
          } else if (row.status === "cancelled" && inWindow) {
            facts.push({
              kind: "deploy.cancelled",
              family: "deploy",
              subjectId: row.appId,
              subjectName: name,
              at: row.startedAt,
              outcome: "neutral",
              href,
            });
          }
          // queued, running and superseded are bookkeeping, not outcomes.
        }
      },
      undefined,
    ),

    // ---- Backups -----------------------------------------------------------
    source(
      "backups",
      unavailable,
      async () => {
        const jobs = await db.query.backupJobs.findMany({
          where: eq(backupJobs.organizationId, orgId),
          columns: { id: true, name: true },
        });
        if (jobs.length === 0) return;
        const jobName = new Map(jobs.map((j) => [j.id, j.name]));

        const rows = await db
          .select({
            jobId: backups.jobId,
            status: backups.status,
            startedAt: backups.startedAt,
          })
          .from(backups)
          .where(
            and(
              inArray(
                backups.jobId,
                jobs.map((j) => j.id),
              ),
              gte(backups.startedAt, baselineFrom),
            ),
          );

        for (const row of rows) {
          if (row.status !== "success" && row.status !== "failed") continue;
          const failed = row.status === "failed";
          if (row.startedAt < since) {
            bump(counts, "backup", row.jobId, failed ? "failures" : "successes");
            continue;
          }
          facts.push({
            kind: failed ? "backup.failed" : "backup.success",
            family: "backup",
            subjectId: row.jobId,
            subjectName: jobName.get(row.jobId) ?? row.jobId,
            at: row.startedAt,
            outcome: failed ? "failure" : "success",
            href: "/backups",
          });
        }
      },
      undefined,
    ),

    // ---- Cron --------------------------------------------------------------
    source(
      "cron",
      unavailable,
      async () => {
        if (appIds.length === 0) return;
        const jobs = await db.query.cronJobs.findMany({
          where: inArray(cronJobs.appId, appIds),
          columns: { id: true, name: true, appId: true },
        });
        if (jobs.length === 0) return;
        const job = new Map(jobs.map((j) => [j.id, j]));

        const rows = await db
          .select({
            cronJobId: cronJobRuns.cronJobId,
            status: cronJobRuns.status,
            startedAt: cronJobRuns.startedAt,
          })
          .from(cronJobRuns)
          .where(
            and(
              inArray(
                cronJobRuns.cronJobId,
                jobs.map((j) => j.id),
              ),
              gte(cronJobRuns.startedAt, baselineFrom),
            ),
          );

        for (const row of rows) {
          const failed = row.status === "failed";
          if (row.startedAt < since) {
            bump(counts, "cron", row.cronJobId, failed ? "failures" : "successes");
            continue;
          }
          const meta = job.get(row.cronJobId);
          facts.push({
            kind: failed ? "cron.failed" : "cron.success",
            family: "cron",
            subjectId: row.cronJobId,
            subjectName: meta?.name ?? row.cronJobId,
            at: row.startedAt,
            outcome: failed ? "failure" : "success",
            href: meta ? `/apps/${appSlug.get(meta.appId) ?? ""}/cron` : undefined,
          });
        }
      },
      undefined,
    ),

    // ---- Domain reachability ----------------------------------------------
    source(
      "domains",
      unavailable,
      async () => {
        if (appIds.length === 0) return;
        const rows = await db
          .select({
            domainId: domainChecks.domainId,
            domain: domains.domain,
            appId: domains.appId,
            reachable: domainChecks.reachable,
            checkedAt: domainChecks.checkedAt,
          })
          .from(domainChecks)
          .innerJoin(domains, eq(domainChecks.domainId, domains.id))
          .where(
            and(
              inArray(domains.appId, appIds),
              gte(domainChecks.checkedAt, baselineFrom),
            ),
          );

        for (const row of rows) {
          if (row.checkedAt < since) {
            bump(
              counts,
              "domain",
              row.domainId,
              row.reachable ? "successes" : "failures",
            );
            continue;
          }
          // Successful probes only feed the baseline — a working site is not news.
          if (row.reachable) continue;
          facts.push({
            kind: "domain.unreachable",
            family: "domain",
            subjectId: row.domainId,
            subjectName: row.domain,
            at: row.checkedAt,
            outcome: "failure",
            href: `/apps/${appSlug.get(row.appId) ?? ""}`,
          });
        }
      },
      undefined,
    ),

    // ---- Security scans ----------------------------------------------------
    source(
      "security",
      unavailable,
      async () => {
        const rows = await db
          .select({
            id: appSecurityScans.id,
            appId: appSecurityScans.appId,
            status: appSecurityScans.status,
            criticalCount: appSecurityScans.criticalCount,
            warningCount: appSecurityScans.warningCount,
            startedAt: appSecurityScans.startedAt,
          })
          .from(appSecurityScans)
          .where(
            and(
              eq(appSecurityScans.organizationId, orgId),
              gte(appSecurityScans.startedAt, baselineFrom),
            ),
          );

        for (const row of rows) {
          const bad = row.criticalCount > 0 || row.status === "failed";
          if (row.startedAt < since) {
            bump(counts, "security", row.appId, bad ? "failures" : "successes");
            continue;
          }
          if (!bad) continue;
          facts.push({
            kind: "security.scan-findings",
            family: "security",
            subjectId: row.appId,
            subjectName: appName.get(row.appId) ?? row.appId,
            at: row.startedAt,
            outcome: "failure",
            detail:
              row.criticalCount > 0
                ? `${row.criticalCount} critical, ${row.warningCount} warnings`
                : "Scan failed",
            href: `/apps/${appSlug.get(row.appId) ?? ""}/security`,
          });
        }
      },
      undefined,
    ),

    // ---- Audit trail -------------------------------------------------------
    source(
      "activity",
      unavailable,
      async () => {
        const rows = await db
          .select({
            id: activities.id,
            action: activities.action,
            appId: activities.appId,
            createdAt: activities.createdAt,
          })
          .from(activities)
          .where(
            and(
              eq(activities.organizationId, orgId),
              gte(activities.createdAt, since),
              // Your own actions are not news to you.
              or(isNull(activities.userId), ne(activities.userId, userId)),
            ),
          );

        for (const row of rows) {
          if (IGNORED_ACTIONS.has(row.action)) continue;
          const subjectId = row.appId ?? row.action;
          if (row.action === "volume.drift_detected") {
            facts.push({
              kind: "volume.drift",
              family: "app",
              subjectId,
              subjectName: appName.get(subjectId) ?? subjectId,
              at: row.createdAt,
              outcome: "failure",
              detail: "Volume contents drifted from the last deploy",
              href: row.appId ? `/apps/${appSlug.get(row.appId) ?? ""}` : undefined,
            });
            continue;
          }
          facts.push({
            kind: row.action,
            family: "org",
            subjectId,
            subjectName: row.appId
              ? (appName.get(row.appId) ?? subjectId)
              : row.action,
            at: row.createdAt,
            outcome: "neutral",
            href: "/activity",
          });
        }
      },
      undefined,
    ),

    // ---- System alerts -----------------------------------------------------
    // Host alerts never reach Postgres as events; the rate-limiter's persisted
    // state is the only durable record of them firing.
    source(
      "system-alerts",
      unavailable,
      async () => {
        const row = await db.query.systemSettings.findFirst({
          where: (t, { eq: matches }) => matches(t.key, ALERT_STATE_KEY),
        });
        if (!row) return;
        const parsed = JSON.parse(row.value) as Record<
          string,
          { lastFired: string; count: number }
        >;

        for (const [stateKey, entry] of Object.entries(parsed)) {
          const split = stateKey.indexOf(":");
          if (split < 0) continue;
          const type = stateKey.slice(0, split);
          const subject = stateKey.slice(split + 1);
          const kind = ALERT_KIND[type];
          if (!kind) continue;

          const firedAt = new Date(entry.lastFired);
          if (Number.isNaN(firedAt.getTime()) || firedAt < since) continue;

          // Every prior firing is a reason to care less about this one.
          bump(counts, "system", subject, "failures", Math.max(entry.count - 1, 0));

          facts.push({
            kind,
            family: "system",
            subjectId: subject,
            subjectName: subject || type,
            at: firedAt,
            outcome: "failure",
            detail: entry.count > 1 ? `Fired ${entry.count} times total` : undefined,
          });
        }
      },
      undefined,
    ),
  ]);

  // ---- App runtime state ---------------------------------------------------
  await source(
    "app-state",
    unavailable,
    async () => {
      if (appIds.length === 0) return;
      const windowDeploys = await db
        .select({
          appId: deployments.appId,
          status: deployments.status,
          startedAt: deployments.startedAt,
        })
        .from(deployments)
        .where(
          and(
            inArray(deployments.appId, appIds),
            gte(deployments.startedAt, new Date(since.getTime() - 30 * 60_000)),
          ),
        );
      facts.push(...deriveAppStateFacts(orgApps, windowDeploys, since));
    },
    undefined,
  );

  const baselines: AwayBaselines = {};
  for (const [key, value] of counts) baselines[key] = value;

  return { since, now, facts, baselines, unavailable };
}
