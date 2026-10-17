import { and, gte, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import type { BuildOutcome, ImageTransfer } from "./build-placement";
import type { StageTimings } from "./stage-timings";

export const PLACEMENT_WINDOW_DAYS = 30;

/** Builds in one place over the window, with medians over the builds that ran there. */
export type BuildStats = {
  /** Builds there; for this server, every build here, fallbacks included. */
  builds: number;
  /** For a target, builds it failed that ran here; for this server, builds here after a target failed. */
  fallbacks: number;
  registry: number;
  ssh: number;
  /** SSH copies that skipped the registry for a layer too big to push. */
  skipped: number;
  mixed: number;
  medianBuildMs: number | null;
  medianContextBytes: number | null;
  medianImageBytes: number | null;
  medianPeakBytes: number | null;
  medianTransferMs: number | null;
  medianTransferBytes: number | null;
};

export type PlacementStats = { here: BuildStats | null; targets: Record<string, BuildStats> };

export type PlacementRow = {
  targetId: string | null;
  outcome: BuildOutcome | null;
  transfer: ImageTransfer | null;
  transferMs: number | null;
  transferBytes: number | null;
  contextBytes: number | null;
  imageBytes: number | null;
  peakBytes: number | null;
  timings: StageTimings | null;
};

function median(values: (number | null)[]): number | null {
  const sorted = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** The build and export phases, the build's time from admission. */
function buildMs(t: StageTimings | null): number | null {
  if (!t?.build) return null;
  return t.build.ms + (t.export?.ms ?? 0);
}

function stats(all: PlacementRow[], ranThere: PlacementRow[]): BuildStats {
  const count = (via: ImageTransfer) => all.filter((r) => r.transfer === via).length;
  return {
    builds: all.length,
    fallbacks: all.filter((r) => r.outcome === "fallback").length,
    registry: count("registry"),
    ssh: count("ssh") + count("session") + count("registry_skipped"),
    skipped: count("registry_skipped"),
    mixed: count("mixed"),
    // A fallback's build phase includes its time on the target.
    medianBuildMs: median(ranThere.filter((r) => r.outcome !== "fallback").map((r) => buildMs(r.timings))),
    medianContextBytes: median(ranThere.map((r) => r.contextBytes)),
    medianImageBytes: median(ranThere.map((r) => r.imageBytes)),
    medianPeakBytes: median(ranThere.map((r) => r.peakBytes)),
    medianTransferMs: median(ranThere.map((r) => r.transferMs)),
    medianTransferBytes: median(ranThere.map((r) => r.transferBytes)),
  };
}

/** This server's and each target's numbers from deployment rows. */
export function summarizePlacements(rows: PlacementRow[]): PlacementStats {
  const local = rows.filter((r) => r.outcome === "here" || r.outcome === "fallback");
  const byTarget = new Map<string, PlacementRow[]>();
  for (const r of rows) {
    if (!r.targetId || !r.outcome) continue;
    byTarget.set(r.targetId, [...(byTarget.get(r.targetId) ?? []), r]);
  }
  return {
    here: local.length ? stats(local, local) : null,
    targets: Object.fromEntries([...byTarget].map(([id, all]) => [id, stats(all, all.filter((r) => r.outcome === "target"))])),
  };
}

/** Numbers for builds started in the last 30 days. */
export async function placementStats(now = Date.now()): Promise<PlacementStats> {
  const since = new Date(now - PLACEMENT_WINDOW_DAYS * 24 * 60 * 60_000);
  const rows = await db
    .select({
      targetId: deployments.buildTargetId,
      outcome: deployments.buildOutcome,
      transfer: deployments.imageTransfer,
      transferMs: deployments.imageTransferMs,
      transferBytes: deployments.imageTransferBytes,
      contextBytes: deployments.buildContextBytes,
      imageBytes: deployments.imageBytes,
      peakBytes: deployments.buildPeakBytes,
      timings: deployments.stageTimings,
    })
    .from(deployments)
    .where(and(isNotNull(deployments.buildOutcome), gte(deployments.startedAt, since)));
  return summarizePlacements(rows);
}
