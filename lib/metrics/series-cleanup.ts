// Deletes time series that belong to deleted apps. Keys are matched on their exact structure.

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema/apps";
import { logger } from "@/lib/logger";
import { tsRedis, forgetKey } from "./ts-client";

const log = logger.child("series-cleanup");

const SCAN_COUNT = 500;

/** Series with no sample for this long and no matching app are orphans. Spares live non-app containers. */
const ORPHAN_QUIET_MS = 60 * 60_000;

/** Metric segment of a per-container key: metrics:{project}:{metric}:{container}. */
const CONTAINER_METRICS = new Set([
  "cpu", "memory", "memoryLimit", "networkRx", "networkTx", "diskWrite",
  "gpuUtilization", "gpuMemoryUsed", "gpuMemoryTotal", "gpuTemperature",
]);

/** Namespaces that are not app projects. */
const RESERVED = new Set(["business", "system"]);

export type SeriesOwner =
  | { kind: "project"; project: string }
  | { kind: "logs"; appId: string };

/** Reads the owner out of a metrics key, or null for keys this module doesn't manage. */
export function parseSeriesKey(key: string): SeriesOwner | null {
  if (!key.startsWith("metrics:")) return null;
  const parts = key.slice("metrics:".length).split(":");
  if (RESERVED.has(parts[0])) return null;

  // metrics:logs:{appId}:{errors|lines}
  if (parts[0] === "logs") {
    return parts.length === 3 && (parts[2] === "errors" || parts[2] === "lines")
      ? { kind: "logs", appId: parts[1] }
      : null;
  }

  // metrics:{project}:disk
  if (parts.length >= 2 && parts[parts.length - 1] === "disk") {
    return { kind: "project", project: parts.slice(0, -1).join(":") };
  }

  // metrics:{project}:{metric}:{container}
  if (parts.length >= 3 && CONTAINER_METRICS.has(parts[parts.length - 2]) && parts[parts.length - 1]) {
    return { kind: "project", project: parts.slice(0, -2).join(":") };
  }

  return null;
}

/** Escapes glob characters for a SCAN MATCH pattern. */
function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, "\\$&");
}

async function scanKeys(pattern: string, onBatch: (keys: string[]) => Promise<void>): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = (await tsRedis.call(
      "SCAN", cursor, "MATCH", pattern, "COUNT", String(SCAN_COUNT),
    )) as [string, string[]];
    cursor = next;
    if (keys.length > 0) await onBatch(keys);
  } while (cursor !== "0");
}

async function deleteKeys(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const removed = (await tsRedis.call("UNLINK", ...keys)) as number;
  for (const key of keys) forgetKey(key);
  return removed;
}

/** Deletes every series for the given compose projects and app ids. Returns the number of keys removed. */
export async function deleteAppSeries(opts: { projects: string[]; appIds: string[] }): Promise<number> {
  let removed = 0;

  for (const project of new Set(opts.projects)) {
    await scanKeys(`metrics:${escapeGlob(project)}:*`, async (keys) => {
      // The glob also matches longer project names that contain a colon.
      const own = keys.filter((key) => {
        const owner = parseSeriesKey(key);
        return owner?.kind === "project" && owner.project === project;
      });
      removed += await deleteKeys(own);
    });
  }

  for (const appId of new Set(opts.appIds)) {
    removed += await deleteKeys([`metrics:logs:${appId}:errors`, `metrics:logs:${appId}:lines`]);
  }

  log.info(`Deleted ${removed} series for ${opts.projects.length} project(s)`);
  return removed;
}

/** Whether a series has had no sample within the quiet window. A missing key counts as quiet. */
async function isQuiet(key: string, now: number): Promise<boolean> {
  try {
    const last = (await tsRedis.call("TS.GET", key)) as [string, string] | null;
    return !last || now - parseInt(last[0], 10) > ORPHAN_QUIET_MS;
  } catch {
    return false;
  }
}

/** Deletes series whose app no longer exists and that have gone quiet. Returns the number of keys removed. */
export async function sweepOrphanSeries(): Promise<number> {
  const rows = await db.select({ id: apps.id, name: apps.name }).from(apps);
  const appIds = new Set(rows.map((r) => r.id));
  const appNames = new Set(rows.map((r) => r.name));
  const now = Date.now();
  let removed = 0;

  await scanKeys("metrics:*", async (keys) => {
    const orphans: string[] = [];
    for (const key of keys) {
      const owner = parseSeriesKey(key);
      if (!owner) continue;

      if (owner.kind === "logs") {
        if (!appIds.has(owner.appId)) orphans.push(key);
        continue;
      }
      if (appNames.has(owner.project)) continue;
      if (await isQuiet(key, now)) orphans.push(key);
    }
    removed += await deleteKeys(orphans);
  });

  log.info(`Deleted ${removed} orphaned series`);
  return removed;
}

const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

let sweepTimer: NodeJS.Timeout | null = null;

async function runSweep(): Promise<void> {
  try {
    await sweepOrphanSeries();
  } catch (err) {
    log.error("Orphan series sweep failed:", err);
  }
}

/** Sweeps orphaned series now and every six hours. */
export function startOrphanSeriesSweeper(): void {
  if (sweepTimer) return;
  void runSweep();
  sweepTimer = setInterval(runSweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}
