// ---------------------------------------------------------------------------
// Reading the time-series store once for a whole page.
//
// Scoping happens in memory, not in the query: every app and project on a page
// draws from the same handful of TS.MRANGE calls rather than one per card.
// ---------------------------------------------------------------------------

import { tsRedis } from "./ts-client";

/** Metric names the resource layer reads. */
export const RESOURCE_METRICS = [
  "cpu",
  "memory",
  "memoryLimit",
  "networkRx",
  "networkTx",
  "disk",
  "diskWrite",
  "gpuUtilization",
  "gpuMemoryUsed",
  "gpuMemoryTotal",
  "gpuTemperature",
] as const;

export type ResourceMetricName = (typeof RESOURCE_METRICS)[number];

/** One container's samples for one metric, with the labels that place it. */
export type LabeledSeries = {
  key: string;
  /** `project` label — the top-level app's name, not the Vardo project. */
  project: string;
  /** `service` label, present on decomposed stack children. */
  service: string | null;
  /** Short container id, empty on series stored per project rather than per container. */
  container: string;
  points: [number, number][];
};

export type SeriesByMetric = Map<ResourceMetricName, LabeledSeries[]>;

/**
 * How each metric collapses inside a bucket. Gauges and cumulative counters
 * take the bucket's last sample; averaging a counter reports a value that was
 * never true of any instant.
 */
const AGGREGATOR: Record<ResourceMetricName, string> = {
  cpu: "avg",
  memory: "last",
  memoryLimit: "max",
  networkRx: "last",
  networkTx: "last",
  disk: "last",
  diskWrite: "last",
  gpuUtilization: "avg",
  gpuMemoryUsed: "last",
  gpuMemoryTotal: "max",
  gpuTemperature: "avg",
};

function labelMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) return out;
  for (const pair of raw) {
    if (Array.isArray(pair) && pair.length >= 2 && typeof pair[0] === "string") {
      out[pair[0]] = pair[1] == null ? "" : String(pair[1]);
    }
  }
  return out;
}

function parseSeries(result: unknown): LabeledSeries[] {
  if (!Array.isArray(result)) return [];
  const out: LabeledSeries[] = [];

  for (const entry of result) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const key = String(entry[0]);
    const labels = labelMap(entry[1]);
    const raw = entry[2];
    if (!Array.isArray(raw)) continue;

    const points: [number, number][] = [];
    for (const point of raw) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const ts = Number(point[0]);
      const value = Number(point[1]);
      if (Number.isFinite(ts) && Number.isFinite(value)) points.push([ts, value]);
    }
    points.sort((a, b) => a[0] - b[0]);

    out.push({
      key,
      project: labels.project ?? "",
      service: labels.service ? labels.service : null,
      container: labels.container ?? "",
      points,
    });
  }

  return out;
}

/**
 * Every series carrying samples in the window, for each named metric.
 *
 * Series belonging to containers that stopped before `fromMs` come back empty
 * and are dropped, so a project's stale history — thousands of keys after a few
 * weeks of redeploys — never reaches the aggregation.
 */
export async function readSeries(
  metrics: readonly ResourceMetricName[],
  fromMs: number,
  toMs: number,
  bucketMs?: number,
): Promise<SeriesByMetric> {
  const results = await Promise.all(
    metrics.map(async (metric): Promise<[ResourceMetricName, LabeledSeries[]]> => {
      const args: string[] = [
        String(Math.floor(fromMs)),
        String(Math.floor(toMs)),
        "SELECTED_LABELS",
        "project",
        "service",
        "container",
      ];
      if (bucketMs && bucketMs > 0) {
        args.push("AGGREGATION", AGGREGATOR[metric], String(Math.floor(bucketMs)));
      }
      args.push("FILTER", `metric=${metric}`);

      try {
        const raw = await tsRedis.call("TS.MRANGE", ...args);
        return [metric, parseSeries(raw).filter((s) => s.points.length > 0)];
      } catch {
        return [metric, []];
      }
    }),
  );

  return new Map(results);
}
