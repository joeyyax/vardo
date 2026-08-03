// ---------------------------------------------------------------------------
// Usage and limit for the five resources, for one app or one project.
//
// Pure: everything it needs is passed in, so the aggregation and the
// absent-versus-zero rules are testable without a Redis or a database.
// ---------------------------------------------------------------------------

import type { SeriesByMetric } from "./resource-samples";
import {
  aggregate,
  counterRate,
  counterRateSeries,
  limitCoverage,
  seriesInScope,
  type ResourceScope,
} from "./resource-scope";
import {
  reading,
  notCollected,
  type Absence,
  type LimitKind,
  type ResourceSnapshot,
  type SeriesPoint,
} from "./resource-types";

export * from "./resource-types";

/** Ceilings the host imposes on everything running on it. */
export type HostCapacity = {
  /** Physical cores. Null when Docker's /info was unreachable. */
  cpuCores: number | null;
  /** Physical RAM in bytes. */
  memoryBytes: number | null;
};

/** Configured limits for one app row, in the units the app table stores. */
export type AppLimits = {
  /** Cores, written into deploy.resources.limits.cpus. Null when unset. */
  cpuLimit: number | null;
  /** Megabytes declared on the app record. */
  memoryLimitMb: number | null;
  /** Bytes the app's volume limit allows. Null when no limit row exists. */
  diskLimitBytes: number | null;
  /** Whether the app asks for GPU devices. */
  gpuEnabled: boolean;
};

export const NO_LIMITS: AppLimits = {
  cpuLimit: null,
  memoryLimitMb: null,
  diskLimitBytes: null,
  gpuEnabled: false,
};

export type SnapshotInput = {
  subject: ResourceSnapshot["subject"];
  scope: ResourceScope;
  series: SeriesByMetric;
  /** One entry per app the subject covers. A project passes its top-level apps. */
  limits: AppLimits[];
  host: HostCapacity;
  /** Set when `/system/df` cannot attribute disk to this subject at all. */
  diskSupported: boolean;
  now: number;
};

const MB = 1024 * 1024;

/**
 * Combine per-app caps into one ceiling.
 *
 * `enforced` needs every app in scope capped — a project where one app runs
 * uncapped has no total limit, only a floor, and saying otherwise is how a
 * "90% of limit" bar appears for a subject that can use the whole host.
 */
function combineLimits(
  values: (number | null)[],
  capacity: number | null,
): { limit: number | null; limitKind: LimitKind } {
  const capped = values.filter((v): v is number => v !== null && v > 0);

  if (values.length > 0 && capped.length === values.length) {
    return { limit: sum(capped), limitKind: "enforced" };
  }
  if (capped.length > 0) {
    return { limit: sum(capped), limitKind: "partial" };
  }
  if (capacity !== null && capacity > 0) {
    return { limit: capacity, limitKind: "capacity" };
  }
  return { limit: null, limitKind: "none" };
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** Nothing fresh in scope: stale when the subject has series at all, else absent. */
function absenceFor(
  series: SeriesByMetric,
  metric: Parameters<SeriesByMetric["get"]>[0],
  scope: ResourceScope,
): Absence {
  return seriesInScope(series.get(metric), scope).length > 0 ? "stale" : "not-collected";
}

export function buildSnapshot(input: SnapshotInput): ResourceSnapshot {
  const { scope, series, limits, host, now } = input;

  const cpu = aggregate(series.get("cpu"), scope, "sum", now);
  const memory = aggregate(series.get("memory"), scope, "sum", now);
  const gpuUtil = aggregate(series.get("gpuUtilization"), scope, "sum", now);
  const gpuMemUsed = aggregate(series.get("gpuMemoryUsed"), scope, "sum", now);
  const gpuMemTotal = aggregate(series.get("gpuMemoryTotal"), scope, "max", now);
  const gpuTemp = aggregate(series.get("gpuTemperature"), scope, "avg", now);
  const disk = aggregate(series.get("disk"), scope, "sum", now);

  const rx = counterRate(series.get("networkRx"), scope, now);
  const tx = counterRate(series.get("networkTx"), scope, now);
  const write = counterRate(series.get("diskWrite"), scope, now);

  // ---- CPU -----------------------------------------------------------------
  // 100 means one core saturated, so a core count converts to the same scale.
  const cpuCapacity = host.cpuCores !== null ? host.cpuCores * 100 : null;
  const cpuLimits = combineLimits(
    limits.map((l) => (l.cpuLimit !== null ? l.cpuLimit * 100 : null)),
    cpuCapacity,
  );
  const cpuReading = reading({
    kind: "cpu",
    unit: "percent",
    usage: cpu.value,
    absence: absenceFor(series, "cpu", scope),
    ...cpuLimits,
    series: cpu.series,
  });

  // ---- Memory --------------------------------------------------------------
  // The limit the kernel actually enforces, read back off the containers,
  // beats the number the app record asks for — those disagree until a redeploy.
  const observed = limitCoverage(series.get("memoryLimit"), scope, now);
  const declared = combineLimits(
    limits.map((l) => (l.memoryLimitMb !== null ? l.memoryLimitMb * MB : null)),
    host.memoryBytes,
  );
  const memoryLimits =
    observed.total > 0
      ? observed.limited === observed.total
        ? { limit: observed.sum, limitKind: "enforced" as LimitKind }
        : observed.limited > 0
          ? { limit: observed.sum, limitKind: "partial" as LimitKind }
          : host.memoryBytes !== null
            ? { limit: host.memoryBytes, limitKind: "capacity" as LimitKind }
            : { limit: null, limitKind: "none" as LimitKind }
      : declared;

  const memoryReading = reading({
    kind: "memory",
    unit: "bytes",
    usage: memory.value,
    absence: absenceFor(series, "memory", scope),
    ...memoryLimits,
    series: memory.series,
  });

  // ---- Disk ----------------------------------------------------------------
  // Per-container filesystem accounting is off in cAdvisor, so the only figure
  // is the one /system/df attributes by label — which names the top-level app.
  const diskLimits = combineLimits(
    limits.map((l) => l.diskLimitBytes),
    null,
  );
  const diskReading = input.diskSupported
    ? reading({
        kind: "disk",
        unit: "bytes",
        usage: disk.value,
        absence: absenceFor(series, "disk", scope),
        ...diskLimits,
        series: disk.series,
      })
    : notCollected("disk", "bytes", "unsupported");

  // ---- Network -------------------------------------------------------------
  // No mechanism anywhere in Vardo caps container throughput.
  const networkUsage = rx.value === null && tx.value === null ? null : (rx.value ?? 0) + (tx.value ?? 0);
  const networkReading = reading({
    kind: "network",
    unit: "bytesPerSecond",
    usage: networkUsage,
    absence: absenceFor(series, "networkRx", scope),
    limitKind: "none",
    series: sumSeries(
      counterRateSeries(series.get("networkRx"), scope),
      counterRateSeries(series.get("networkTx"), scope),
    ),
  });

  // ---- GPU -----------------------------------------------------------------
  // Utilization is a share of the devices the containers touch, and no Docker
  // setting caps it — the ceiling is the hardware.
  const gpuAbsence: Absence =
    seriesInScope(series.get("gpuUtilization"), scope).length > 0
      ? "stale"
      : limits.some((l) => l.gpuEnabled)
        ? "stale"
        : "not-collected";

  const gpuReading = reading({
    kind: "gpu",
    unit: "percent",
    usage: gpuUtil.value,
    absence: gpuAbsence,
    limit: 100,
    limitKind: "capacity",
    series: gpuUtil.series,
  });

  const containerCount = Math.max(cpu.containers, memory.containers);
  const sampledAt = newest([cpu.at, memory.at, rx.at, tx.at, disk.at, gpuUtil.at]);

  return {
    subject: input.subject,
    containerCount,
    sampledAt,
    cpu: cpuReading,
    memory: memoryReading,
    disk: diskReading,
    network: networkReading,
    gpu: gpuReading,
    extras: {
      networkRx: reading({
        kind: "networkRx",
        unit: "bytesPerSecond",
        usage: rx.value,
        absence: absenceFor(series, "networkRx", scope),
        limitKind: "none",
        series: counterRateSeries(series.get("networkRx"), scope),
      }),
      networkTx: reading({
        kind: "networkTx",
        unit: "bytesPerSecond",
        usage: tx.value,
        absence: absenceFor(series, "networkTx", scope),
        limitKind: "none",
        series: counterRateSeries(series.get("networkTx"), scope),
      }),
      gpuMemory: reading({
        kind: "gpuMemory",
        unit: "bytes",
        usage: gpuMemUsed.value,
        absence: gpuAbsence,
        limit: gpuMemTotal.value,
        limitKind: gpuMemTotal.value === null ? "unknown" : "capacity",
        series: gpuMemUsed.series,
      }),
      gpuTemperature: reading({
        kind: "gpuTemperature",
        unit: "celsius",
        usage: gpuTemp.value,
        absence: gpuAbsence,
        limitKind: "none",
        series: gpuTemp.series,
      }),
      diskWrite: reading({
        kind: "diskWrite",
        unit: "bytesPerSecond",
        usage: write.value,
        absence: absenceFor(series, "diskWrite", scope),
        limitKind: "none",
        series: counterRateSeries(series.get("diskWrite"), scope),
      }),
    },
  };
}

/** Add two rate series bucket by bucket. */
function sumSeries(a: SeriesPoint[], b: SeriesPoint[]): SeriesPoint[] {
  const byTimestamp = new Map<number, number>();
  for (const [ts, value] of [...a, ...b]) {
    if (value === null) continue;
    byTimestamp.set(ts, (byTimestamp.get(ts) ?? 0) + value);
  }
  return [...byTimestamp.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([ts, value]) => [ts, Math.round(value * 100) / 100] as SeriesPoint);
}

function newest(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length > 0 ? Math.max(...known) : null;
}
