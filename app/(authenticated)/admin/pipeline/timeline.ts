// Time geometry for the Deploys card: where each segment, ghost and lane bar sits in the window.

import type { StageSegment, TimedStage } from "@/lib/pipeline/segments";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import type { PipelineBuilder, PipelineDeploy } from "@/lib/pipeline/types";
import { stageHead, type SharedStage } from "@/lib/ui/deploy-stage";

export const WINDOWS = { "5m": 5 * 60_000, "10m": 10 * 60_000, "1h": 60 * 60_000, "6h": 6 * 60 * 60_000 } as const;
export type WindowKey = keyof typeof WINDOWS;
export const DEFAULT_WINDOW: WindowKey = "5m";

/** The share of the track that is future, right of now. */
export const FUTURE = 0.2;

/** The stages drawn as bars, in loop order. */
export const BAR_STAGES = ["prepare", "build", "start", "health", "switch"] as const;
export type BarStage = (typeof BAR_STAGES)[number];

/** Percent across the track for epoch ms `t`. */
export function xPct(t: number, now: number, windowMs: number): number {
  return ((t - (now - windowMs)) / (windowMs * (1 + FUTURE))) * 100;
}

export type Placed = { left: number; width: number };

/** A span's place on the track, clamped; null when it's wholly outside. */
export function place(start: number, end: number, now: number, windowMs: number): Placed | null {
  const l = Math.max(0, xPct(start, now, windowMs));
  const r = Math.min(100, xPct(end, now, windowMs));
  if (r <= 0 || l >= 100 || r <= l) return null;
  return { left: l, width: r - l };
}

/** Gridline step and label step per window, in ms. */
function steps(windowMs: number): { grid: number; label: number } {
  if (windowMs <= WINDOWS["5m"]) return { grid: 30_000, label: 60_000 };
  if (windowMs <= WINDOWS["10m"]) return { grid: 60_000, label: 120_000 };
  if (windowMs <= WINDOWS["1h"]) return { grid: 5 * 60_000, label: 10 * 60_000 };
  return { grid: 30 * 60_000, label: 60 * 60_000 };
}

export type Tick = { at: number; x: number };

/** Gridlines on round times across the past part of the window. */
export function gridlines(now: number, windowMs: number): Tick[] {
  const { grid } = steps(windowMs);
  const out: Tick[] = [];
  for (let t = Math.ceil((now - windowMs) / grid) * grid; t <= now; t += grid) out.push({ at: t, x: xPct(t, now, windowMs) });
  return out;
}

/** Axis labels on round times; none so close to the left edge or to now that they'd collide. */
export function axisTicks(now: number, windowMs: number): Tick[] {
  const { label } = steps(windowMs);
  const nowX = xPct(now, now, windowMs);
  return gridlines(now, windowMs).filter((t) => t.at % label === 0 && t.x > 6 && nowX - t.x > 7);
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "45s", "24m", "5h 12m", "2d". */
export function span(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(s / 86400)}d`;
}

/** "in about 26s", or "any moment" once the estimate has run out. */
export function soon(at: number, now: number): string {
  return at - now < 5_000 ? "any moment" : `in about ${span(at - now)}`;
}

export const isLive =(d: PipelineDeploy) => d.finishedAt === null && (d.status === "running" || d.status === "queued");
export const waitsForBuilder = (d: PipelineDeploy) => isLive(d) && d.waitReason === "build-slot";

/** The segment open now, if any. */
export function openSegment(d: PipelineDeploy): StageSegment | null {
  if (!isLive(d)) return null;
  for (let i = d.segments.length - 1; i >= 0; i--) if (d.segments[i].end === null) return d.segments[i];
  return null;
}

/** The shared stage a live deploy is in. */
export function currentStage(d: PipelineDeploy): SharedStage {
  if (d.stop === "rolledBack") return "rollingBack";
  if (waitsForBuilder(d)) return "wait";
  return openSegment(d)?.stage ?? (d.stop === "queue" ? "queued" : "prepare");
}

/** "Building on Long House · 1:08": the stage, present tense, and how long it's run. */
export function headText(d: PipelineDeploy, now: number): string {
  const seg = openSegment(d);
  const since = d.stop === "rolledBack" || !seg ? d.stageSince : seg.start;
  return `${stageHead(currentStage(d), { builder: d.builderName })} · ${clock(now - since)}`;
}

export type BarPiece = {
  key: string;
  kind: "queued" | BarStage | "wait" | "fail" | "back";
  start: number;
  end: number;
  /** Still growing at now. */
  open: boolean;
  /** The shared stage it was in, kept when a failure repaints it. */
  stage: SharedStage;
  /** Its name without the time: "Build on Long House". */
  label: string;
  title: string;
};

export const PIECE_TITLE: Record<string, string> = {
  queued: "Queued",
  prepare: "Prepare",
  wait: "Waiting for a builder",
  build: "Build",
  start: "Start",
  health: "Health check",
  switch: "Switch traffic",
  back: "Rolling back",
};

/** A rollback's hatch is drawn at least this long so it reads at any window. */
const MIN_BACK_MS = 2_000;

/**
 * The bar's pieces in order. A failure paints its last stage red; a rollback adds a red hatch after it,
 * derived from the status because no rollback spans are recorded.
 */
export function barPieces(d: PipelineDeploy, now: number): BarPiece[] {
  const end = (s: StageSegment) => s.end ?? d.finishedAt ?? now;
  const pieces: BarPiece[] = [];
  d.segments.forEach((s, i) => {
    if (s.stage === "live" || s.stage === "rollingBack") return;
    const kind = s.stage === "queued" ? "queued" : s.stage === "wait" ? "wait" : (s.stage as BarStage);
    const stop = end(s);
    const label = s.stage === "build" && d.builderName ? `Build on ${d.builderName}` : PIECE_TITLE[kind];
    pieces.push({ key: `${s.stage}-${i}`, kind, start: s.start, end: stop, open: s.end === null && isLive(d), stage: s.stage, label, title: `${label} ${clock(stop - s.start)}` });
  });

  if (d.rollback) {
    const from = pieces.at(-1)?.end ?? d.queuedAt;
    const to = d.finishedAt ?? now;
    pieces.push({ key: "back", kind: "back", start: from, end: to, open: isLive(d), stage: "rollingBack", label: isLive(d) ? "Rolling back" : "Rolled back", title: `Rolling back ${clock(to - from)}` });
    return pieces;
  }

  const failedHere = d.failed || (d.stop === "rolledBack" && !isLive(d));
  const last = [...pieces].reverse().find((p) => p.kind !== "queued" && p.kind !== "wait");
  if (failedHere && last) {
    last.kind = "fail";
    last.title = `${last.title} · failed`;
  }
  if (d.stop === "rolledBack" && last) {
    const to = Math.max(d.finishedAt ?? now, last.end + MIN_BACK_MS);
    pieces.push({ key: "back", kind: "back", start: last.end, end: to, open: false, stage: "rollingBack", label: "Rolled back", title: "Rolled back · the old version kept serving" });
  }
  return pieces;
}

export type Ghost = { key: string; kind: BarStage | "wait"; start: number; end: number; title: string };

/** The build median for an app on a builder: its own there, else any app's there, else its own anywhere. */
export function buildMedian(medians: PipelineMedians, appId: string, builder: string | null): number | null {
  const app = medians.apps[appId];
  if (builder) {
    const own = app?.builders[builder] ?? medians.builders[builder];
    if (own !== undefined) return own;
  }
  return app?.build ?? null;
}

export function stageMedian(medians: PipelineMedians, d: PipelineDeploy, stage: BarStage, builder: string | null): number | null {
  if (stage === "build") return buildMedian(medians, d.appId, builder);
  return medians.apps[d.appId]?.[stage as TimedStage] ?? null;
}

/**
 * Where a live deploy should go next, at its app's medians. A waiting deploy goes to the builder it most likely
 * gets. The chain stops at the first stage without a median, so nothing is drawn that history doesn't back.
 */
export function ghostPieces(d: PipelineDeploy, medians: PipelineMedians, now: number): Ghost[] {
  if (!isLive(d) || d.stop === "rolledBack" || d.status === "queued") return [];
  const out: Ghost[] = [];
  let at = now;
  let builder = d.builder;
  let from: number;
  if (waitsForBuilder(d)) {
    if (!d.next) return [];
    out.push({ key: "g-wait", kind: "wait", start: now, end: Math.max(now, d.next.at), title: `Waits about ${clock(d.next.at - now)} for ${d.next.name}` });
    at = Math.max(now, d.next.at);
    builder = d.next.builder;
    from = BAR_STAGES.indexOf("build");
  } else {
    const cur = currentStage(d);
    const i = BAR_STAGES.indexOf(cur as BarStage);
    if (i < 0) return [];
    const med = stageMedian(medians, d, cur as BarStage, builder);
    if (med === null) return [];
    const seg = openSegment(d);
    const left = med - (now - (seg?.start ?? d.stageSince));
    if (left > 0) {
      out.push({ key: `g-${cur}`, kind: cur as BarStage, start: now, end: now + left, title: `${PIECE_TITLE[cur]}, about ${clock(med)} (median)` });
      at = now + left;
    }
    from = i + 1;
  }
  for (const stage of BAR_STAGES.slice(from)) {
    const med = stageMedian(medians, d, stage, builder);
    if (med === null) break;
    out.push({ key: `g-${stage}`, kind: stage, start: at, end: at + med, title: `${PIECE_TITLE[stage]}, about ${clock(med)} (median)` });
    at += med;
  }
  return out;
}

export type LaneBar = {
  key: string;
  kind: "build" | "own" | "next";
  deployId: string | null;
  label: string;
  start: number;
  end: number;
  open: boolean;
  title: string;
};
export type LaneMark = { key: string; deployId: string | null; at: number; title: string };
export type Lane = { builder: PipelineBuilder; index: number; bars: LaneBar[]; marks: LaneMark[] };

const MAX_LANES = 6;
const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** One lane per build slot: builds that ran there, a linked instance's own build, where waiting deploys land, refusals. */
export function builderLanes(
  builders: PipelineBuilder[],
  deploys: PipelineDeploy[],
  medians: PipelineMedians,
  now: number,
  windowMs: number,
): Lane[] {
  const byId = new Map(deploys.map((d) => [d.id, d]));
  return builders.flatMap((b) => {
    const count = Math.min(Math.max(b.slots, b.holders.length, 1), MAX_LANES);
    const lanes: Lane[] = Array.from({ length: count }, (_, index) => ({ builder: b, index, bars: [], marks: [] }));
    const lastEnd = lanes.map(() => -Infinity);
    const put = (lane: number, bar: LaneBar) => {
      lanes[lane].bars.push(bar);
      lastEnd[lane] = Math.max(lastEnd[lane], bar.end);
    };

    // Holders keep their slot's lane.
    const pinned = new Set<string>();
    b.holders.slice(0, count).forEach((h, i) => {
      if (h.deploymentId) {
        pinned.add(h.deploymentId);
        const d = byId.get(h.deploymentId);
        const bar = d ? buildBar(d, now) : null;
        if (bar) put(i, bar);
        return;
      }
      const start = h.since ?? now - windowMs * 0.1;
      // A refusal's × sits on this bar, so the label gives way to it.
      put(i, { key: `own-${h.token}`, kind: "own", deployId: null, label: b.refusals.length ? "" : "Its own build", start, end: now, open: true, title: `${b.name}'s own build` });
    });

    const others = deploys
      .filter((d) => d.builder === b.id && !pinned.has(d.id))
      .map((d) => buildBar(d, now))
      .filter((x): x is LaneBar => x !== null)
      .sort((x, y) => x.start - y.start);
    for (const bar of others) {
      const free = lastEnd.findIndex((e) => e <= bar.start);
      put(free >= 0 ? free : lastEnd.indexOf(Math.min(...lastEnd)), bar);
    }

    // When each lane frees: a holder at its start plus the build median there.
    const freeAt = lanes.map((_, i) => {
      const h = b.holders[i];
      if (!h) return now;
      if (!h.deploymentId || h.since === null) return Infinity;
      const ms = buildMedian(medians, byId.get(h.deploymentId)?.appId ?? "", b.id);
      return ms === null ? Infinity : Math.max(now, h.since + ms);
    });
    const landing = deploys.filter((d) => waitsForBuilder(d) && d.next?.builder === b.id).sort((x, y) => x.next!.at - y.next!.at);
    for (const d of landing) {
      const lane = freeAt.indexOf(Math.min(...freeAt));
      if (lane < 0 || !Number.isFinite(freeAt[lane])) break;
      const ms = buildMedian(medians, d.appId, b.id);
      if (ms === null) continue;
      const start = Math.max(d.next!.at, freeAt[lane]);
      lanes[lane].bars.push({ key: `next-${d.id}`, kind: "next", deployId: d.id, label: d.appName, start, end: start + ms, open: false, title: `${d.appName} lands here next, ${soon(start, now)}` });
      freeAt[lane] = start + ms;
    }

    for (const r of b.refusals) {
      const d = r.deploymentId ? byId.get(r.deploymentId) : undefined;
      const why = r.needBytes !== null && r.freeBytes !== null ? `: needs ${gib(r.needBytes)} GiB, ${gib(r.freeBytes)} GiB free` : r.reason === "full" ? ": its builder was full" : "";
      lanes[0].marks.push({ key: `refused-${r.at}`, deployId: r.deploymentId, at: r.at, title: `${b.name} refused ${d?.appName ?? "a build"}${why}` });
    }
    return lanes;
  });
}

/** The span a deploy held a build slot: its build after its last wait for one, transfer included. */
function buildBar(d: PipelineDeploy, now: number): LaneBar | null {
  const lastWait = d.segments.filter((s) => s.stage === "wait").at(-1);
  if (lastWait && lastWait.end === null) return null;
  const builds = d.segments.filter((s) => s.stage === "build" && s.start >= (lastWait?.end ?? -Infinity));
  if (builds.length === 0) return null;
  const start = builds[0].start;
  const open = builds.some((s) => s.end === null) && isLive(d);
  const end = open ? now : Math.max(...builds.map((s) => s.end ?? d.finishedAt ?? now));
  return { key: `build-${d.id}`, kind: "build", deployId: d.id, label: d.appName, start, end, open, title: `${d.appName} · build ${open ? "running" : clock(end - start)}` };
}

/** Milliseconds a deploy has spent in each bar stage; the current one counts to now. */
export function stageTimes(d: PipelineDeploy, now: number): Partial<Record<BarStage | "wait", number>> {
  const out: Partial<Record<BarStage | "wait", number>> = {};
  for (const s of d.segments) {
    if (s.stage === "queued" || s.stage === "live" || s.stage === "rollingBack") continue;
    const k = s.stage as BarStage | "wait";
    out[k] = (out[k] ?? 0) + Math.max(0, (s.end ?? d.finishedAt ?? now) - s.start);
  }
  return out;
}

/** A window that runs from `start` to `end`, for a track zoomed to one deploy. */
export function zoomFrame(start: number, end: number): { now: number; windowMs: number } {
  const windowMs = Math.max(1, end - start) / (1 + FUTURE);
  return { now: start + windowMs, windowMs };
}

/** Room left past the latest mark on a zoomed track. */
const ZOOM_PAD = 0.04;

/**
 * A zoomed track's span: from the deploy's queue to its finish, or while it runs to its expected finish.
 * Either way it fits the last good deploy's length, so the reference bar is never cut.
 */
export function zoomRange(
  d: PipelineDeploy,
  pieces: Pick<BarPiece, "end">[],
  ghosts: Pick<Ghost, "end">[],
  previousMs: number | null,
  now: number,
): { start: number; end: number } {
  const start = d.queuedAt;
  const done = pieces.at(-1)?.end ?? d.finishedAt ?? now;
  const reach = Math.max(isLive(d) ? Math.max(now, ghosts.at(-1)?.end ?? now) : done, start + (previousMs ?? 0), start + 1_000);
  return { start, end: isLive(d) ? reach + (reach - start) * ZOOM_PAD : reach };
}

/** Gridlines across a zoomed track, every 30s, minute or 5m so they stay a few dozen at most. */
export function zoomGrid(start: number, end: number): number[] {
  const len = end - start;
  const step = len <= 5 * 60_000 ? 30_000 : len <= 15 * 60_000 ? 60_000 : 5 * 60_000;
  const out: number[] = [];
  for (let t = start + step; t < end; t += step) out.push(t);
  return out;
}

/** When a running deploy should go live at its medians, or null when the ghosts stop short of Switch traffic. */
export function expectedLive(ghosts: Ghost[]): number | null {
  const last = ghosts.at(-1);
  return last?.kind === "switch" ? last.end : null;
}

/** Text width at the label font, for deciding whether a label fits inside its bar. */
let canvas: CanvasRenderingContext2D | null | undefined;
export function textWidth(text: string, font = '500 11px "Atkinson Hyperlegible Next", sans-serif'): number {
  if (canvas === undefined) canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!canvas) return text.length * 6.5;
  canvas.font = font;
  return canvas.measureText(text).width;
}
