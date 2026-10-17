// The apps each backup job covers and whether they're running, for staleness.

import { and, eq, gte, inArray, max } from "drizzle-orm";

import { runStateColumns } from "@/lib/apps/run-state";
import { db } from "@/lib/db";
import { activities, apps, backupJobApps, backupJobVolumes, volumes } from "@/lib/db/schema";
import type { JobApp, ScheduledBackupJob } from "./staleness";

/** Starts older than this can't shift a job's staleness. */
const START_LOOKBACK_MS = 31 * 24 * 3_600_000;

/** Attaches each job's apps, with run state and last operator start, and whether it covers an unowned volume. */
export async function withJobApps<T extends ScheduledBackupJob>(jobs: T[], now = new Date()): Promise<T[]> {
  if (jobs.length === 0) return jobs;
  const jobIds = jobs.map((j) => j.id);
  const [linked, viaVolume] = await Promise.all([
    db
      .select({ jobId: backupJobApps.backupJobId, id: apps.id, ...runStateColumns })
      .from(backupJobApps)
      .innerJoin(apps, eq(apps.id, backupJobApps.appId))
      .where(inArray(backupJobApps.backupJobId, jobIds)),
    db
      .select({ jobId: backupJobVolumes.backupJobId, volumeAppId: volumes.appId, id: apps.id, ...runStateColumns })
      .from(backupJobVolumes)
      .innerJoin(volumes, eq(volumes.id, backupJobVolumes.volumeId))
      .leftJoin(apps, eq(apps.id, volumes.appId))
      .where(inArray(backupJobVolumes.backupJobId, jobIds)),
  ]);

  const appIds = [...new Set([...linked.map((r) => r.id), ...viaVolume.flatMap((r) => (r.id ? [r.id] : []))])];
  const starts = appIds.length
    ? await db
        .select({ appId: activities.appId, at: max(activities.createdAt) })
        .from(activities)
        .where(
          and(
            inArray(activities.appId, appIds),
            eq(activities.action, "app.started"),
            gte(activities.createdAt, new Date(now.getTime() - START_LOOKBACK_MS)),
          ),
        )
        .groupBy(activities.appId)
    : [];
  const startedAt = new Map(starts.flatMap((s) => (s.appId && s.at ? [[s.appId, s.at] as const] : [])));

  const byJob = new Map<string, { apps: Map<string, JobApp>; loose: boolean }>();
  const entry = (jobId: string) => {
    let e = byJob.get(jobId);
    if (!e) byJob.set(jobId, (e = { apps: new Map(), loose: false }));
    return e;
  };
  const add = (jobId: string, a: Omit<JobApp, "startedAt">) => entry(jobId).apps.set(a.id, { ...a, startedAt: startedAt.get(a.id) ?? null });

  for (const { jobId, ...a } of linked) add(jobId, a);
  for (const { jobId, volumeAppId, id, status, parked, lastRunningAt, exitReason } of viaVolume) {
    if (!volumeAppId || !id || status === null) entry(jobId).loose = true;
    else add(jobId, { id, status, parked, lastRunningAt, exitReason });
  }

  return jobs.map((job) => {
    const e = byJob.get(job.id);
    return { ...job, apps: e ? [...e.apps.values()] : [], looseVolumes: e?.loose ?? false };
  });
}
