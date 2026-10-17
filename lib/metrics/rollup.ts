// Rolls the 7-day time-series store and uptime's domain checks into hourly per-app rows kept 13 months.
// Production only: each app's default environment, never its staging or preview containers and hosts.

import { eq, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { appMetricHours, environments, systemSettings } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";
import { uptimeClient } from "@/lib/uptime/client";
import { IntervalLoop, type LoopContext } from "@/lib/worker/interval-loop";
import { parseSeries } from "./resource-samples";
import { RETENTION_MS, tsRedis } from "./ts-client";
import {
  HOUR_MS,
  SLOT_MS,
  SLOT_READS,
  buildHourRows,
  ceilHour,
  floorHour,
  type HourRow,
  type RollupApp,
  type SlotRead,
  type SlotSeries,
} from "./rollup-math";

const log = logger.child("metrics-rollup");

/** Hours before the current one that every pass re-rolls, for late samples and checks. */
const REROLL_HOURS = 2;
/** Hours read per pass of the store. Bounds memory on a catch-up. */
const CHUNK_HOURS = 24;
const UPSERT_BATCH = 500;
/** Past the hour, so the last probe of the hour has landed. */
const RUN_OFFSET_MS = 5 * 60_000;
const PRUNE_EVERY_MS = 24 * HOUR_MS;

export const WATERMARK_KEY = "metrics-rollup:rolled-until";

/** Oldest hour start kept: thirteen calendar months back. */
export function rollupCutoff(now: number): Date {
  const d = new Date(floorHour(now));
  d.setUTCMonth(d.getUTCMonth() - 13);
  return d;
}

/** Hours [from, to) a pass rolls up: past the watermark, re-rolling recent hours, within raw retention. */
export function rollupRange(now: number, watermark: number | null): { fromMs: number; toMs: number } {
  const toMs = floorHour(now);
  const oldest = ceilHour(now - RETENTION_MS);
  const resume = Math.min(watermark ?? oldest, toMs - REROLL_HOURS * HOUR_MS);
  return { fromMs: Math.max(oldest, resume), toMs };
}

/** Delay until RUN_OFFSET_MS past the next hour. */
export function msUntilNextRun(now: number): number {
  const next = floorHour(now) + RUN_OFFSET_MS;
  return next > now ? next - now : next + HOUR_MS - now;
}

async function readWatermark(): Promise<number | null> {
  const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, WATERMARK_KEY) });
  const ms = row ? Date.parse(row.value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

async function writeWatermark(ms: number): Promise<void> {
  const value = new Date(ms).toISOString();
  await db
    .insert(systemSettings)
    .values({ key: WATERMARK_KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
}

/** One TS.MRANGE per read across every container, aggregated into epoch-aligned slots. Errors propagate. */
async function readSlots(fromMs: number, toMs: number): Promise<SlotSeries> {
  const entries = await Promise.all(
    (Object.keys(SLOT_READS) as SlotRead[]).map(async (read) => {
      const { metric, aggregation } = SLOT_READS[read];
      const raw = await tsRedis.call(
        "TS.MRANGE",
        String(fromMs),
        String(toMs - 1),
        // SELECTED_LABELS would read ALIGN as a label name; it goes last.
        "ALIGN", "0",
        "AGGREGATION", aggregation, String(SLOT_MS),
        "SELECTED_LABELS", "project", "service", "container", "environment", "containerName",
        "FILTER", `metric=${metric}`,
      );
      return [read, parseSeries(raw).filter((s) => s.container && s.points.length > 0)] as const;
    }),
  );
  return Object.fromEntries(entries) as SlotSeries;
}

const NO_SERIES: SlotSeries = { cpu: [], samples: [], memory: [], memoryLimit: [], networkRx: [], networkTx: [] };

async function readChecks(fromMs: number, toMs: number) {
  const rows = await uptimeClient.domainChecks(fromMs, toMs);
  return rows.map((r) => ({ appId: r.appId, checkedAt: new Date(r.at), reachable: r.reachable, responseTimeMs: r.responseTimeMs }));
}

async function readApps(): Promise<RollupApp[]> {
  const [rows, defaults] = await Promise.all([
    db.query.apps.findMany({
      columns: { id: true, organizationId: true, name: true, parentAppId: true, composeService: true },
      with: { parentApp: { columns: { name: true } } },
    }),
    db
      .select({ appId: environments.appId, name: environments.name })
      .from(environments)
      .where(eq(environments.isDefault, true)),
  ]);
  const defaultOf = new Map(defaults.map((e) => [e.appId, e.name]));
  return rows.map((app) => ({
    ...app,
    defaultEnvironment: (app.parentAppId && defaultOf.get(app.parentAppId)) || defaultOf.get(app.id) || null,
  }));
}

const excluded = (column: string) => sql.raw(`excluded."${column}"`);

async function upsertRows(rows: HourRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await db
      .insert(appMetricHours)
      .values(rows.slice(i, i + UPSERT_BATCH))
      .onConflictDoUpdate({
        target: [appMetricHours.appId, appMetricHours.hour],
        set: {
          organizationId: excluded("organization_id"),
          metricMinutes: excluded("metric_minutes"),
          sampleCount: excluded("sample_count"),
          cpuAvg: excluded("cpu_avg"),
          cpuPeak: excluded("cpu_peak"),
          memoryAvg: excluded("memory_avg"),
          memoryPeak: excluded("memory_peak"),
          memoryLimit: excluded("memory_limit"),
          networkRxBytes: excluded("network_rx_bytes"),
          networkTxBytes: excluded("network_tx_bytes"),
          checksTotal: excluded("checks_total"),
          checksUp: excluded("checks_up"),
          responseCount: excluded("response_count"),
          responseMsSum: excluded("response_ms_sum"),
          responseHistogram: excluded("response_histogram"),
          updatedAt: new Date(),
        },
      });
  }
}

export type RollupResult = { fromMs: number; toMs: number; hours: number; rows: number };

/** Rolls up every completed hour not yet written. Idempotent; a failed chunk leaves the watermark before it. */
export async function rollupHours(opts: { now?: number; active?: () => boolean } = {}): Promise<RollupResult> {
  const now = opts.now ?? Date.now();
  const { fromMs, toMs } = rollupRange(now, await readWatermark());
  const withMetrics = isFeatureEnabled("metrics");
  let rows = 0;
  let rolledTo = fromMs;

  if (fromMs < toMs) {
    const appList = await readApps();
    for (let start = fromMs; start < toMs; start += CHUNK_HOURS * HOUR_MS) {
      if (opts.active && !opts.active()) break;
      const end = Math.min(toMs, start + CHUNK_HOURS * HOUR_MS);
      // One slot early, so the first slot's counter delta has a reading before it.
      const [series, checks] = await Promise.all([
        withMetrics ? readSlots(start - SLOT_MS, end) : NO_SERIES,
        readChecks(start, end),
      ]);
      const chunk = buildHourRows({ apps: appList, series, checks, fromMs: start, toMs: end });
      await upsertRows(chunk);
      await writeWatermark(end);
      rows += chunk.length;
      rolledTo = end;
    }
  }

  return { fromMs, toMs: rolledTo, hours: (rolledTo - fromMs) / HOUR_MS, rows };
}

/** Deletes rows older than thirteen months. Returns the count removed. */
export async function pruneRollups(now = Date.now()): Promise<number> {
  const deleted = await db
    .delete(appMetricHours)
    .where(lt(appMetricHours.hour, rollupCutoff(now)))
    .returning({ appId: appMetricHours.appId });
  return deleted.length;
}

const globalForRollup = globalThis as unknown as { __vardo_rollup_pruned_at?: number };

async function runPass(ctx: LoopContext): Promise<RollupResult> {
  const result = await rollupHours({ active: () => ctx.active });
  if (result.rows > 0) log.info(`Rolled up ${result.hours} hour(s) into ${result.rows} row(s)`);

  const now = Date.now();
  if (now - (globalForRollup.__vardo_rollup_pruned_at ?? 0) >= PRUNE_EVERY_MS) {
    const pruned = await pruneRollups(now);
    globalForRollup.__vardo_rollup_pruned_at = now;
    if (pruned > 0) log.info(`Pruned ${pruned} hourly row(s) past thirteen months`);
  }
  return result;
}

/** Shortly after start, then a few minutes past each hour. */
export const metricsRollupLoop = new IntervalLoop({
  name: "metrics-rollup",
  intervalMs: () => msUntilNextRun(Date.now()),
  firstRunMs: 60_000,
  log,
  run: runPass,
});
