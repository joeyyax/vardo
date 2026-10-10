// Loads the history notification charts draw from. Best effort: a slow or failed query drops its chart.

import type { BusEvent } from "@/lib/bus/events";
import type { MailSeries } from "./templates/context";

const TIMEOUT_MS = 1500;
const HOUR_MS = 60 * 60 * 1000;

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

/** History for the event's charts. Never throws; returns what it found in time. */
export async function loadMailSeries(event: BusEvent, now = Date.now()): Promise<MailSeries> {
  switch (event.type) {
    case "alert.fired":
      return event.alerts.some((a) => a.type === "host.disk") ? { dockerDisk24h: await withTimeout(dockerDisk(now)) } : {};
    case "disk.write-alert":
      return event.metricsProject
        ? { diskWritesHourly: await withTimeout(diskWrites(event.metricsProject, event.containerId, now)) }
        : {};
    default:
      return {};
  }
}
