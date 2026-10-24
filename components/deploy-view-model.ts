// The deploy view's words and pieces: a Pipeline row zoomed in to one deploy.

import {
  BAR_STAGES,
  PIECE_TITLE,
  barPieces,
  clock,
  expectedLive,
  ghostPieces,
  isLive,
  soon,
  stageMedian,
  stageTimes,
  waitsForBuilder,
  type BarPiece,
  type BarStage,
} from "@/app/(authenticated)/admin/pipeline/timeline";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import type { PipelineDeploy } from "@/lib/pipeline/types";
import { DEPLOY_STAGE_KEYS, ROLLBACK_STAGE_KEYS, SHARED_STAGE_LABELS, sharedStage, stageHead, type SharedStage } from "@/lib/ui/deploy-stage";
import { formatSpan, isQueuedView, type DeployView } from "@/lib/ui/deploy-wait";

/** One piece of the zoomed bar, past or expected. */
export type ViewPiece = {
  key: string;
  kind: BarPiece["kind"];
  /** The log stage a click on it filters to. */
  stage: SharedStage;
  start: number;
  end: number;
  open: boolean;
  ghost: boolean;
  /** The name above it; empty for none. */
  label: string;
  tone: "warn" | "error" | null;
  title: string;
};

/** The bar's pieces, then the ghosts at the app's medians. A ghost finishing the open stage carries no name of its own. */
export function viewPieces(d: PipelineDeploy, medians: PipelineMedians, now: number): ViewPiece[] {
  const pieces = barPieces(d, now);
  const failedStage = pieces.find((p) => p.kind === "fail")?.stage ?? "health";
  const real = pieces.map((p): ViewPiece => {
    const stage = p.kind === "wait" ? "build" : p.kind === "back" ? (d.rollback ? "rollingBack" : failedStage) : p.stage;
    const tone = p.kind === "wait" ? "warn" : p.kind === "fail" || p.kind === "back" ? "error" : null;
    const label = p.kind === "queued" ? "" : p.kind === "wait" ? SHARED_STAGE_LABELS.wait : p.label;
    return { key: p.key, kind: p.kind, stage, start: p.start, end: p.end, open: p.open, ghost: false, label, tone, title: p.title };
  });
  const open = real.find((p) => p.open);
  const builder = d.next?.name ?? d.builderName;
  const ghosts = expected(d, medians, now).map((g, i): ViewPiece => {
    const rest = i === 0 && open?.kind === g.kind;
    const name = g.kind === "wait" ? "" : g.kind === "build" && builder ? `Build on ${builder}` : PIECE_TITLE[g.kind];
    return { key: g.key, kind: g.kind, stage: g.kind === "wait" ? "build" : g.kind, start: g.start, end: g.end, open: false, ghost: true, label: rest ? "" : name, tone: g.kind === "wait" ? "warn" : null, title: g.title };
  });
  return [...real, ...ghosts];
}

/** When the deploy should go live at its medians; null when it isn't running or history can't say. */
export function liveAt(d: PipelineDeploy, medians: PipelineMedians, now: number): number | null {
  return isLive(d) ? expectedLive(expected(d, medians, now)) : null;
}

/** The ghosts at medians. An auto-rollback restores an image, so it has none. */
function expected(d: PipelineDeploy, medians: PipelineMedians, now: number) {
  return d.rollback ? [] : ghostPieces(d, medians, now);
}

/** Where a run's stages start: its first piece after the queue, or `now` while it's still in line. */
export function startLine(pieces: Pick<BarPiece, "kind" | "start">[], now: number): number {
  return pieces.find((p) => p.kind !== "queued")?.start ?? now;
}

/** One piece of a comparison lane, moved so the run starts on this deploy's start line. */
export type LanePiece = { key: string; kind: BarStage | "wait"; start: number; end: number };

export type CompareLane = {
  key: string;
  kind: "median" | "last" | "failed";
  name: string;
  meta: string;
  pieces: LanePiece[];
  /** When the run would end, on this deploy's clock. */
  end: number;
};

function day(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A past run on this deploy's clock: its failure drawn as the stage it was in, no rollback hatch, named for the stage it died in. */
function pastLane(run: PipelineDeploy, kind: "last" | "failed", line: number, now: number): CompareLane | null {
  const all = barPieces(run, now).filter((p) => p.kind !== "queued" && p.kind !== "back");
  if (!all.length) return null;
  const offset = line - startLine(all, now);
  const pieces = all.map((p): LanePiece => ({
    key: p.key,
    kind: p.kind === "fail" ? (p.stage as BarStage) : (p.kind as BarStage | "wait"),
    start: p.start + offset,
    end: p.end + offset,
  }));
  const fail = all.find((p) => p.kind === "fail");
  const meta = kind === "last" ? day(run.queuedAt) : fail ? PIECE_TITLE[fail.stage] : "Failed";
  return { key: run.id, kind, name: kind === "last" ? "Last deploy" : day(run.queuedAt), meta, pieces, end: pieces.at(-1)!.end };
}

/** The app's median run, stage by stage until one has no median, from the start line. */
function medianPieces(d: PipelineDeploy, medians: PipelineMedians, line: number): LanePiece[] {
  const out: LanePiece[] = [];
  let at = line;
  for (const stage of BAR_STAGES) {
    const ms = stageMedian(medians, d, stage, d.builder);
    if (ms === null) break;
    out.push({ key: `m-${stage}`, kind: stage, start: at, end: at + ms });
    at += ms;
  }
  return out;
}

/** The runs this deploy is measured against, all starting on its start line: the median, the last good deploy and recent failures. */
export function compareLanes(
  d: PipelineDeploy,
  { previous, failures, medians }: { previous: PipelineDeploy | null; failures: PipelineDeploy[]; medians: PipelineMedians },
  now: number,
): CompareLane[] {
  if (d.rollback) return [];
  const line = startLine(barPieces(d, now), now);
  const median = medianPieces(d, medians, line);
  const lanes = [
    median.length ? { key: "median", kind: "median" as const, name: "Median", meta: "Last 30 days", pieces: median, end: median.at(-1)!.end } : null,
    previous ? pastLane(previous, "last", line, now) : null,
    ...failures.map((f) => pastLane(f, "failed", line, now)),
  ];
  return lanes.filter((l): l is CompareLane => l !== null);
}

/** A finished stage against its median: `deltaMs` below zero is faster. `at` is where the stage ended. */
export type Split = { stage: BarStage; at: number; ms: number; medianMs: number; deltaMs: number };

/** Each stage this deploy finished, against the app's median for it, in loop order until one lacks a median. */
export function stageSplits(d: PipelineDeploy, medians: PipelineMedians, now: number): Split[] {
  const pieces = barPieces(d, now);
  const times = stageTimes(d, now);
  const out: Split[] = [];
  for (const stage of BAR_STAGES) {
    const last = pieces.findLast((p) => p.kind === stage);
    if (!last || last.open || times[stage] === undefined) break;
    const medianMs = stageMedian(medians, d, stage, d.builder);
    if (medianMs === null) break;
    out.push({ stage, at: last.end, ms: times[stage]!, medianMs, deltaMs: times[stage]! - medianMs });
  }
  return out;
}

/** "−0:12", "+0:03", "0:00". */
export function signedClock(ms: number): string {
  if (Math.abs(ms) < 1_000) return "0:00";
  return `${ms < 0 ? "−" : "+"}${clock(Math.abs(ms))}`;
}

/** The timeslip: every stage of a successful deploy against its median. Null unless each has one. */
export function timeslip(d: PipelineDeploy, medians: PipelineMedians, now: number): Split[] | null {
  if (isLive(d) || d.status !== "success" || d.rollback) return null;
  const splits = stageSplits(d, medians, now);
  return splits.length === BAR_STAGES.length ? splits : null;
}

export type HeadlineTone = "active" | "warn" | "issue" | "good" | "neutral";
export type Headline = { title: string; tone: HeadlineTone };

const LIVE = new Set(["queued", "running"]);

function stageName(engine: string | null | undefined): string | null {
  const shared = sharedStage(engine);
  return shared && shared !== "queued" && shared !== "live" ? SHARED_STAGE_LABELS[shared] : null;
}

/**
 * The card's title: the stage in flight, present tense with its builder, or how the run ended.
 * The stream's stages speak first; the row's stage stands in until they do.
 */
export function deployHeadline(
  row: { status: string; stage?: string | null },
  stages: Record<string, string>,
  view: DeployView,
  { builder = null, rollbackRun = false }: { builder?: string | null; rollbackRun?: boolean } = {},
): Headline {
  const failedEngine = Object.entries(stages).find(([, s]) => s === "failed")?.[0] ?? (row.status === "failed" ? (row.stage ?? null) : null);
  const failed = stageName(failedEngine);
  const rollback = rollbackRun || ROLLBACK_STAGE_KEYS.some((k) => stages[k]);
  if (!LIVE.has(row.status)) {
    if (row.status === "success") return rollback ? { title: "Rolled back · previous version live", tone: "good" } : { title: "Live", tone: "good" };
    if (row.status === "rolled_back") return { title: failed ? `${failed} failed · rolled back` : "Rolled back", tone: "issue" };
    if (row.status === "failed") return { title: failed ? `${failed} failed` : "Failed", tone: "issue" };
    if (row.status === "superseded") return { title: "Replaced by a newer deploy", tone: "neutral" };
    return { title: "Cancelled", tone: "neutral" };
  }
  if (rollback) return { title: stageHead("rollingBack"), tone: "issue" };
  if (failed) return { title: `${failed} failed · rolling back`, tone: "issue" };
  if (view.held === "build") return { title: stageHead("wait"), tone: "warn" };
  if (isQueuedView(view)) return { title: view.word, tone: view.tone === "warn" ? "warn" : "neutral" };
  const running = DEPLOY_STAGE_KEYS.findLast((k) => stages[k] === "running") ?? DEPLOY_STAGE_KEYS.findLast((k) => stages[k]) ?? row.stage ?? null;
  const shared = sharedStage(running);
  if (!shared || shared === "queued") return { title: "Starting", tone: "active" };
  return { title: stageHead(shared, { builder }), tone: "active" };
}

/** "12:43 PM". */
export function timeOfDay(at: number, seconds = false): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
}

/** The line under the title: time so far or taken, when it started or finished, and the last good run. */
export function deploySubline(d: PipelineDeploy, previousMs: number | null, now: number): string {
  const last = previousMs !== null ? `last deploy took ${clock(previousMs)}` : null;
  if (isLive(d)) return [`${clock(now - d.queuedAt)} so far`, `started ${timeOfDay(d.queuedAt, true)}`, last].filter(Boolean).join(" · ");
  const end = d.finishedAt ?? now;
  return [`Took ${clock(end - d.queuedAt)}`, last, `finished at ${timeOfDay(end, true)}`].filter(Boolean).join(" · ");
}

export type Summary = { main: string; sub: string | null; tone: "issue" | null };

/** The card's right side: time left and when it goes live, how it compared or what visitors see after a failure. */
export function deploySummary(
  d: PipelineDeploy,
  headline: Headline,
  { liveAt, previousMs, now, fallback }: { liveAt: number | null; previousMs: number | null; now: number; fallback: string | null },
): Summary | null {
  if (headline.tone === "issue") {
    return d.rollback ? { main: "Restoring the previous version", sub: null, tone: "issue" } : previousMs !== null ? { main: "Old version still serving", sub: "Nothing changed for visitors", tone: "issue" } : null;
  }
  if (!isLive(d)) {
    const took = (d.finishedAt ?? now) - d.queuedAt;
    if (d.status !== "success" || previousMs === null) return { main: clock(took), sub: null, tone: null };
    const diff = took - previousMs;
    const sub = Math.abs(diff) < 1_000 ? "as long as last time" : diff > 0 ? `${clock(diff)} slower than last time` : `${clock(-diff)} faster than last time`;
    return { main: clock(took), sub, tone: null };
  }
  if (liveAt !== null) return { main: `About ${formatSpan(Math.max(0, liveAt - now))} left`, sub: `Live at about ${timeOfDay(liveAt)}, at median stage times`, tone: null };
  return fallback ? { main: fallback, sub: null, tone: null } : null;
}

export type Fact = { label: string; value: string; note: string | null };

const TRANSFER: Record<string, string> = {
  registry: "Image back over the registry",
  ssh: "Image back over SSH",
  session: "Image streamed back",
  registry_skipped: "Image copied directly",
  mixed: "Image back over the registry and directly",
};

/** Where it builds, or which builder it waits for. */
export function builtOnFact(d: PipelineDeploy, now: number): Fact {
  if (d.rollback) return { label: "Built on", value: "No build", note: "Restores the last good version" };
  if (waitsForBuilder(d)) return { label: "Built on", value: "Not yet", note: d.next ? `Next free: ${d.next.name} ${soon(d.next.at, now)}` : null };
  if (!d.builderName) return { label: "Built on", value: isLive(d) ? "Not yet" : "Not built", note: null };
  const away = d.builder !== null && d.builder !== "local";
  const note = d.fellBack ? "Fell back to this server" : away ? (d.transfer ? (TRANSFER[d.transfer.via] ?? null) : "Linked builder") : "This server";
  return { label: "Built on", value: d.builderName, note };
}

/** What visitors are served while it runs and once it's done. */
export function releaseFact(d: PipelineDeploy, headline: Headline, hasPrevious: boolean): Fact {
  const label = "Release";
  if (headline.tone === "issue") return { label, value: hasPrevious ? "Previous version live" : "Nothing live", note: d.failure };
  if (!isLive(d)) return { label, value: d.status === "success" ? (hasPrevious ? "Live · previous version ready" : "Live") : hasPrevious ? "Previous version live" : "Nothing live", note: null };
  return { label, value: hasPrevious ? "Previous version live until the switch" : "Goes live at the switch", note: "Rolls back on a failed health check" };
}

/** Lines written in one shared stage. `stage` is null for a log with no stage markers. */
export type LogGroup = { stage: SharedStage | null; lines: string[] };

const MARKER = /^\[stage\] ([\w-]+): (\w+)/;

/** Log lines grouped by the stage they were written in, split at `[stage] x: running` markers, which are dropped. */
export function splitLogByStage(lines: string[]): LogGroup[] {
  const marked = lines.some((l) => MARKER.test(l));
  const out: LogGroup[] = [];
  let cur: SharedStage | null = marked ? "queued" : null;
  for (const line of lines) {
    const m = MARKER.exec(line);
    if (m) {
      const shared = sharedStage(m[1]);
      if (shared && m[2] === "running") cur = shared;
      continue;
    }
    if (line.trim() === "") continue;
    const last = out.at(-1);
    if (last && last.stage === cur) last.lines.push(line);
    else out.push({ stage: cur, lines: [line] });
  }
  return out;
}

/** Stages the log can be filtered to, in loop order. */
export const LOG_STAGES = [...BAR_STAGES, "rollingBack"] as const;
export type LogStage = (typeof LOG_STAGES)[number];

/** The stage a click on a piece filters to: its own, or the failed stage when the log has no rollback lines. */
export function filterStage(stage: SharedStage, groups: LogGroup[]): LogStage | null {
  if (stage === "rollingBack" && !groups.some((g) => g.stage === "rollingBack")) {
    const failed = [...groups].reverse().find((g) => g.stage !== null && g.stage !== "queued" && g.stage !== "live");
    return (failed?.stage as LogStage | undefined) ?? null;
  }
  return (LOG_STAGES as readonly string[]).includes(stage) ? (stage as LogStage) : null;
}
