// Per-app stage medians and per-builder build medians over 30 days of successful deploys, cached.

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import { PLACEMENT_WINDOW_DAYS, placementStats, type PlacementStats } from "@/lib/docker/build-placement-stats";
import type { StageTimings } from "@/lib/docker/stage-timings";
import { median, stageDurations, stageMedians, type StageMedians } from "./segments";

export type MedianRow = {
  appId: string;
  buildOutcome: string | null;
  buildTargetId: string | null;
  queuedAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
  timings: StageTimings | null;
};

/** `apps[appId].builders[builderId]` is that app's build median on that builder, transfer included. */
export type AppMedians = StageMedians & { builders: Record<string, number> };
/** `builders[builderId]` is any app's build median there, transfer included, from placementStats. */
export type PipelineMedians = { apps: Record<string, AppMedians>; builders: Record<string, number> };

const CACHE_MS = 5 * 60_000;
const ROW_LIMIT = 5_000;

/** "local" for this server, the target's id otherwise; null for a fallback, whose build includes the target's try. */
function builtOn(row: Pick<MedianRow, "buildOutcome" | "buildTargetId">): string | null {
  if (row.buildOutcome === "here") return "local";
  if (row.buildOutcome === "target") return row.buildTargetId;
  return null;
}

export function summarizeMedians(rows: MedianRow[], placement: PlacementStats | null): PipelineMedians {
  const byApp = new Map<string, MedianRow[]>();
  for (const r of rows) byApp.set(r.appId, [...(byApp.get(r.appId) ?? []), r]);
  const apps: Record<string, AppMedians> = {};
  for (const [appId, list] of byApp) {
    const durations = list.map((r) => ({ row: r, d: stageDurations({ ...r, status: "success" }) }));
    const builds = new Map<string, number[]>();
    for (const { row, d } of durations) {
      const on = builtOn(row);
      if (on && d.build !== undefined) builds.set(on, [...(builds.get(on) ?? []), d.build]);
    }
    const medians = stageMedians(durations.map(({ row, d }) => (row.buildOutcome === "fallback" ? { ...d, build: undefined } : d)));
    apps[appId] = { ...medians, builders: Object.fromEntries([...builds].map(([b, ms]) => [b, median(ms)!])) };
  }
  const builders: Record<string, number> = {};
  const lane = (s: PlacementStats["here"]) => (s?.medianBuildMs == null ? null : s.medianBuildMs + (s.medianTransferMs ?? 0));
  const here = lane(placement?.here ?? null);
  if (here !== null) builders.local = here;
  for (const [id, s] of Object.entries(placement?.targets ?? {})) {
    const ms = lane(s);
    if (ms !== null) builders[id] = ms;
  }
  return { apps, builders };
}

let cache: { at: number; value: PipelineMedians } | null = null;

/** Test hook. */
export function resetMedianCache(): void {
  cache = null;
}

export async function pipelineMedians(now = Date.now()): Promise<PipelineMedians> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const since = new Date(now - PLACEMENT_WINDOW_DAYS * 24 * 60 * 60_000);
  const [rows, placement] = await Promise.all([
    db
      .select({
        appId: deployments.appId,
        buildOutcome: deployments.buildOutcome,
        buildTargetId: deployments.buildTargetId,
        startedAt: deployments.startedAt,
        claimedAt: deployments.claimedAt,
        finishedAt: deployments.finishedAt,
        timings: deployments.stageTimings,
      })
      .from(deployments)
      .where(and(eq(deployments.status, "success"), gte(deployments.startedAt, since)))
      .orderBy(desc(deployments.startedAt))
      .limit(ROW_LIMIT),
    placementStats(now).catch(() => null),
  ]);
  const t = (d: Date | null) => (d ? d.getTime() : null);
  const value = summarizeMedians(
    rows.map((r) => ({ ...r, queuedAt: r.startedAt.getTime(), claimedAt: t(r.claimedAt), finishedAt: t(r.finishedAt) })),
    placement,
  );
  cache = { at: now, value };
  return value;
}
