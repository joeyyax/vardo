// Loads the history notification charts draw from. Best effort: a slow or failed query drops its chart.

import type { BusEvent } from "@/lib/bus/events";
import type { MailSeries } from "./templates/context";

const TIMEOUT_MS = 1500;
const HOUR_MS = 60 * 60 * 1000;
const BACKUP_HISTORY = 6;

function withTimeout<T>(work: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    work.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), TIMEOUT_MS).unref?.()),
  ]);
}

/** Per-hour increase of a cumulative counter, oldest first. Counter resets count as zero. */
export function hourlyDeltas(points: [number, number][], now: number, hours = 24): number[] {
  const start = now - hours * HOUR_MS;
  const buckets: { first?: number; last?: number }[] = Array.from({ length: hours }, () => ({}));
  for (const [ts, value] of points) {
    const i = Math.floor((ts - start) / HOUR_MS);
    if (i < 0 || i >= hours) continue;
    buckets[i].first ??= value;
    buckets[i].last = value;
  }
  return buckets.map((b) => (b.first === undefined || b.last === undefined ? 0 : Math.max(0, b.last - b.first)));
}

async function dockerDisk(now: number): Promise<number[] | undefined> {
  const { queryDiskHistory } = await import("@/lib/metrics/store-disk");
  const points = await queryDiskHistory(now - 24 * HOUR_MS, now, HOUR_MS);
  return points.length >= 2 ? points.map(([, v]) => v) : undefined;
}

async function diskWrites(project: string, containerId: string, now: number): Promise<number[] | undefined> {
  const { queryDiskWriteRange } = await import("@/lib/metrics/store-container");
  const points = await queryDiskWriteRange(project, containerId, now - 24 * HOUR_MS, now);
  return points.length >= 2 ? hourlyDeltas(points, now) : undefined;
}

async function backupHistory(jobId: string, volumes: string[], exclude: string[]): Promise<Record<string, number[]>> {
  const { db } = await import("@/lib/db");
  const { backups } = await import("@/lib/db/schema");
  const { and, desc, eq, notInArray } = await import("drizzle-orm");
  const history: Record<string, number[]> = {};
  await Promise.all(
    volumes.map(async (volume) => {
      const rows = await db
        .select({ size: backups.sizeBytes })
        .from(backups)
        .where(
          and(
            eq(backups.jobId, jobId),
            eq(backups.volumeName, volume),
            eq(backups.status, "success"),
            ...(exclude.length ? [notInArray(backups.id, exclude)] : []),
          ),
        )
        .orderBy(desc(backups.startedAt))
        .limit(BACKUP_HISTORY);
      const sizes = rows.map((r) => r.size ?? 0).reverse();
      if (sizes.length > 0) history[volume] = sizes;
    }),
  );
  return history;
}

/** History for the event's charts. Never throws; returns what it found in time. */
export async function loadMailSeries(event: BusEvent, now = Date.now()): Promise<MailSeries> {
  switch (event.type) {
    case "alert.fired":
      return event.alerts.some((a) => a.type === "host.disk") ? { dockerDisk24h: await withTimeout(dockerDisk(now)) } : {};
    case "disk.write-alert":
      return event.metricsProject
        ? { diskWritesHourly: await withTimeout(diskWrites(event.metricsProject, event.containerId, now)) }
        : {};
    case "backup.success":
    case "backup.failed": {
      const entries = event.type === "backup.success" ? event.sources ?? [] : event.failures ?? [];
      if (entries.length === 0) return {};
      const ids = entries.map((e) => e.backupId).filter((id): id is string => Boolean(id));
      const volumes = [...new Set(entries.map((e) => e.name))].slice(0, 5);
      return { backupHistory: await withTimeout(backupHistory(event.jobId, volumes, ids)) };
    }
    default:
      return {};
  }
}
