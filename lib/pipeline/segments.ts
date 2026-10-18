// A deploy's time in each shared stage, from its row's stage timings, and medians over many deploys.

import type { Span, StageTimings } from "@/lib/docker/stage-timings";
import type { SharedStage } from "@/lib/ui/deploy-stage";

/** One stretch of a deploy in one shared stage, in epoch ms. `end` is null while it runs. */
export type StageSegment = { stage: SharedStage; start: number; end: number | null };

export type SegmentInput = {
  status: string;
  queuedAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
  timings: StageTimings | null;
};

/** Stages whose medians draw the ghosts. Queued and waiting depend on the line, not the app. */
export const TIMED_STAGES = ["prepare", "build", "start", "health", "switch", "live"] as const;
export type TimedStage = (typeof TIMED_STAGES)[number];
export type StageMedians = Partial<Record<TimedStage, number>>;

/** A slice shorter than this inside the build, around a wait, isn't drawn. */
const MIN_SLICE_MS = 250;

const ENGINE: [TimedStage, string[]][] = [
  ["prepare", ["clone", "compose"]],
  ["build", ["build"]],
  ["start", ["deploy"]],
  ["health", ["healthcheck"]],
  ["switch", ["routing"]],
  ["live", ["cleanup"]],
];

const running = (status: string) => status === "running" || status === "queued";

/** Segments in order. A finished row's open spans end at its finish, as a crashed run's do. */
export function deploySegments(row: SegmentInput, now = Date.now()): StageSegment[] {
  const live = running(row.status);
  const close = (end: number | undefined): number | null => end ?? (live ? null : (row.finishedAt ?? now));
  const spans = row.timings?.stages ? fromStages(row.timings.stages) : fromPhases(row.timings);
  const firstStart = spans.length ? Math.min(...spans.map(([, s]) => s.start)) : null;

  const out: StageSegment[] = [];
  const queuedEnd = row.claimedAt ?? firstStart ?? (live ? null : row.finishedAt);
  out.push({ stage: "queued", start: row.queuedAt, end: queuedEnd === null ? null : Math.max(row.queuedAt, queuedEnd) });

  const waits = (row.timings?.waits ?? []).filter((w) => w.reason === "build-slot");
  for (const [stage, span] of spans) {
    const end = close(span.end);
    if (stage !== "build" || waits.length === 0) {
      out.push({ stage, start: span.start, end });
      continue;
    }
    out.push(...carveWaits(span.start, end, waits, close));
  }
  return out;
}

/** The build's span with its waits for a builder taken out as `wait` segments. */
function carveWaits(start: number, end: number | null, waits: Span[], close: (end: number | undefined) => number | null): StageSegment[] {
  const out: StageSegment[] = [];
  let at = start;
  for (const w of [...waits].sort((a, b) => a.start - b.start)) {
    if (end !== null && w.start >= end) break;
    const wStart = Math.max(at, w.start);
    if (wStart - at >= MIN_SLICE_MS) out.push({ stage: "build", start: at, end: wStart });
    const wEnd = close(w.end);
    out.push({ stage: "wait", start: wStart, end: wEnd === null || end === null ? wEnd : Math.min(wEnd, end) });
    if (wEnd === null) return out;
    at = Math.max(wStart, wEnd);
  }
  if (end === null || end - at >= MIN_SLICE_MS) out.push({ stage: "build", start: at, end });
  return out;
}

function fromStages(stages: Record<string, Span>): [TimedStage, Span][] {
  return ENGINE.flatMap(([stage, keys]): [TimedStage, Span][] => {
    const parts = keys.map((k) => stages[k]).filter((s): s is Span => !!s);
    if (parts.length === 0) return [];
    const open = parts.some((p) => p.end === undefined);
    const ends = parts.map((p) => p.end ?? 0);
    return [[stage, { start: Math.min(...parts.map((p) => p.start)), ...(open ? {} : { end: Math.max(...ends) }) }]];
  });
}

/** Rows from before stage spans: the timed phases, which leave gaps. */
function fromPhases(t: StageTimings | null): [TimedStage, Span][] {
  if (!t) return [];
  const at = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
  const span = (first: keyof StageTimings, last: keyof StageTimings = first): Span | null => {
    const a = t[first] as { startedAt: string; endedAt: string } | undefined;
    const b = (t[last] as { startedAt: string; endedAt: string } | undefined) ?? a;
    const start = at(a?.startedAt);
    const end = at(b?.endedAt);
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  };
  const pairs: [TimedStage, Span | null][] = [
    ["prepare", span("clone")],
    ["build", span("build", "export")],
    ["start", span("up")],
    ["health", span("healthWait")],
    ["live", span("cleanup")],
  ];
  return pairs.filter((p): p is [TimedStage, Span] => p[1] !== null);
}

/** Milliseconds a finished deploy spent in each timed stage; open or missing stages are left out. */
export function stageDurations(row: SegmentInput): StageMedians {
  const out: StageMedians = {};
  for (const seg of deploySegments(row)) {
    if (seg.stage === "queued" || seg.stage === "wait" || seg.stage === "rollingBack" || seg.end === null) continue;
    out[seg.stage] = (out[seg.stage] ?? 0) + Math.max(0, seg.end - seg.start);
  }
  return out;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Each stage's median over the rows that have it. */
export function stageMedians(rows: StageMedians[]): StageMedians {
  const out: StageMedians = {};
  for (const stage of TIMED_STAGES) {
    const m = median(rows.flatMap((r) => (r[stage] === undefined ? [] : [r[stage]!])));
    if (m !== null) out[stage] = m;
  }
  return out;
}
