"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatusMark } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import { clock, isLive, stageTimes, textWidth, xPct, zoomFrame, zoomGrid, zoomRange } from "@/app/(authenticated)/admin/pipeline/timeline";
import { GHOST_CLASS, PIECE_CLASS, Span, Mark as TrackMark, type Frame } from "@/app/(authenticated)/admin/pipeline/track";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import type { DeployTrack } from "@/lib/pipeline/read";
import type { PipelineDeploy } from "@/lib/pipeline/types";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import { SHARED_STAGE_LABELS, type SharedStage } from "@/lib/ui/deploy-stage";
import type { DeployView as StreamView } from "@/lib/ui/deploy-wait";
import { cn } from "@/lib/utils";
import {
  LOG_STAGES,
  builtOnFact,
  compareLanes,
  deployHeadline,
  deploySubline,
  deploySummary,
  filterStage,
  liveAt,
  releaseFact,
  signedClock,
  splitLogByStage,
  stageSplits,
  startLine,
  timeOfDay,
  timeslip,
  viewPieces,
  type CompareLane,
  type Fact,
  type HeadlineTone,
  type LogGroup,
  type LogStage,
  type Split,
  type ViewPiece,
} from "./deploy-view-model";

/** Bars sit at the middle of the 46px bar row. */
const BAR_MID = 23;
const LABEL_FONT = '600 12.5px "Atkinson Hyperlegible Next", sans-serif';
const TAG_FONT = '500 12px "Atkinson Hyperlegible Next", sans-serif';
const TIME_FONT = '600 12px "Geist Mono", ui-monospace, monospace';
const TRACK_POLL_MS = 10_000;

/** The deploy as the Pipeline draws it, refetched when the stream moves and every few seconds while it runs. */
function useDeployTrack(url: string | null, refreshKey: string, live: boolean): DeployTrack | null {
  const [track, setTrack] = useState<{ url: string; data: DeployTrack } | null>(null);
  useEffect(() => {
    if (!url) return;
    let stopped = false;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<DeployTrack>) : null))
        .then((data) => {
          if (!stopped && data) setTrack({ url, data });
        })
        .catch(() => {});
    load();
    const id = live ? setInterval(load, TRACK_POLL_MS) : null;
    return () => {
      stopped = true;
      if (id) clearInterval(id);
    };
  }, [url, refreshKey, live]);
  return track && track.url === url ? track.data : null;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const LABEL_TONE: Record<string, string> = { warn: "text-status-warning", error: "text-status-error" };

const LANE_PIECE: Record<CompareLane["kind"], string> = {
  median: "h-2.5 bg-transparent shadow-none ring-1 ring-inset ring-foreground/25",
  last: "h-1.5 rounded-[2px] opacity-50",
  failed: "h-1 rounded-[2px] bg-muted-foreground opacity-40",
};
const CAR: Record<CompareLane["kind"], string> = {
  median: "size-2.5 rounded-full bg-card ring-2 ring-foreground",
  last: "size-2.5 rounded-full bg-muted-foreground ring-2 ring-card",
  failed: "size-2 rounded-full bg-muted-foreground ring-2 ring-card",
};
const LANE_MID = 19;
const LANE_COLS = "grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_4.5rem] gap-x-4 max-sm:grid-cols-[minmax(0,4.5rem)_minmax(0,1fr)_3.25rem] max-sm:gap-x-2";

/** A past run or the median on this deploy's clock: its stages, where it is now and how it ended. */
function LaneRow({ lane, frame, grid, line, now, live }: { lane: CompareLane; frame: Frame; grid: number[]; line: number; now: number; live: boolean }) {
  const x = (t: number) => xPct(t, frame.now, frame.windowMs);
  const len = lane.end - line;
  const out = lane.kind === "failed" && (!live || now >= lane.end);
  const time = out ? "DND" : clock(live ? Math.min(Math.max(0, now - line), len) : len);
  return (
    <div className={cn(LANE_COLS, "h-[38px] items-center")}>
      <div className="min-w-0 leading-tight">
        <div className={cn("truncate text-[13px] font-semibold", lane.kind === "failed" && "font-medium text-muted-foreground")}>{lane.name}</div>
        <div className="truncate text-xs text-muted-foreground max-sm:hidden">{lane.meta}</div>
      </div>
      <div className="relative h-full">
        {grid.map((t) => (
          <i key={t} className="absolute inset-y-0 w-px bg-foreground/[0.06]" style={{ left: `${x(t)}%` }} />
        ))}
        {lane.pieces.map((p) => (
          <Span
            key={p.key}
            frame={frame}
            start={p.start}
            end={p.end}
            top={LANE_MID}
            className={cn(LANE_PIECE[lane.kind], lane.kind === "last" && PIECE_CLASS[p.kind].replace(/\bh-\S+/g, ""))}
          />
        ))}
        {live && <span className="absolute inset-y-0 w-[1.5px] bg-foreground/45 transition-[left] duration-1000 ease-linear" style={{ left: `${x(now)}%` }} />}
        {live && !out && <TrackMark frame={frame} at={Math.min(Math.max(now, line), lane.end)} top={LANE_MID} className={CAR[lane.kind]} />}
        {out && (
          <X className="absolute size-3 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" style={{ left: `${x(lane.end)}%`, top: LANE_MID }} />
        )}
      </div>
      <div className={cn("text-right font-mono text-[13px] tabular-nums", out || live ? "text-muted-foreground" : "text-foreground")}>{time}</div>
    </div>
  );
}

/**
 * The run on one track: stages above, times below, now and the expected finish. With `lanes`, the median, the
 * last good deploy and recent failures run beside it from the same start line, and each finished stage carries its
 * split against the median.
 */
function ZoomTrack({
  d,
  lanes,
  open,
  splits,
  medians,
  now,
  selected,
  onSelect,
}: {
  d: PipelineDeploy;
  lanes: CompareLane[];
  open: boolean;
  splits: Split[];
  medians: PipelineMedians;
  now: number;
  selected: LogStage | null;
  onSelect: (stage: SharedStage) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const pieces = viewPieces(d, medians, now);
  const real = pieces.filter((p) => !p.ghost);
  const ghosts = pieces.filter((p) => p.ghost);
  const shown = open ? lanes : [];
  const reach = shown.length ? Math.max(...shown.map((l) => l.end)) - d.queuedAt : null;
  const range = zoomRange(d, real, ghosts, reach, now);
  const frame = zoomFrame(range.start, range.end);
  const x = (t: number) => xPct(t, frame.now, frame.windowMs);
  const px = (ms: number) => (ms / (range.end - range.start)) * width;
  const live = isLive(d);
  const end = live ? liveAt(d, medians, now) : null;
  const line = startLine(real, now);
  const grid = zoomGrid(range.start, range.end);
  const cols = lanes.length > 0;

  // The open stage's name may run on over its own remainder ghost.
  const room = (p: ViewPiece, i: number) => {
    const next = pieces[i + 1];
    return px(p.end - p.start) + (p.open && next?.ghost && next.label === "" && next.kind === p.kind ? px(next.end - next.start) : 0);
  };
  const named = width > 0 ? pieces.filter((p, i) => p.label && room(p, i) >= textWidth(p.label, LABEL_FONT) + 8) : [];
  const splitOf = (p: ViewPiece) => (open && !p.ghost ? splits.find((s) => s.stage === p.kind && s.at === p.end) : undefined);
  const timeText = (p: ViewPiece) => `${p.ghost ? "~" : ""}${clock(p.end - p.start)}`;
  const timeWidth = (p: ViewPiece) => {
    const split = splitOf(p);
    return textWidth(timeText(p) + (split ? ` ${signedClock(split.deltaMs)}` : ""), TIME_FONT);
  };
  const timed = width > 0 ? pieces.filter((p) => p.kind !== "queued" && px(p.end - p.start) >= timeWidth(p) + 10) : [];

  const endTag = end !== null ? `Live at about ${timeOfDay(end)}` : "";
  const showEndTag = end !== null && width > 0 && px(end - now) >= textWidth(endTag, TAG_FONT) / 2 + 28;
  const runEnd = real.at(-1)?.end ?? now;
  const versus = splits.reduce((a, s) => a + s.deltaMs, 0);

  const track = (
    <div ref={ref} className="relative min-w-0">
      <div className="relative h-5 text-[12.5px]">
        {named.map((p) => (
          <span
            key={p.key}
            className={cn("absolute bottom-1 whitespace-nowrap font-semibold", p.ghost ? "font-medium text-muted-foreground" : (p.tone && LABEL_TONE[p.tone]) || "text-foreground")}
            style={{ left: `${x(p.start)}%` }}
          >
            {p.label}
          </span>
        ))}
      </div>
      <div className="relative h-[46px]">
        {grid.map((t) => (
          <i key={t} className="absolute inset-y-0 w-px bg-foreground/[0.06]" style={{ left: `${x(t)}%` }} />
        ))}
        {pieces.map((p) => (
          <Span
            key={p.key}
            frame={frame}
            start={p.start}
            end={p.end}
            top={BAR_MID}
            title={p.title}
            lit={selected !== null && !p.ghost && p.kind !== "queued" && filterStage(p.stage, []) === selected}
            head={p.open ? (p.tone === "warn" ? "warn" : p.tone === "error" ? "error" : "fg") : undefined}
            bind={{ onClick: () => onSelect(p.stage) }}
            className={cn(
              "cursor-pointer",
              p.ghost
                ? cn("h-4 bg-transparent shadow-none ring-1 ring-inset", GHOST_CLASS[p.kind as keyof typeof GHOST_CLASS])
                : cn(PIECE_CLASS[p.kind], p.kind !== "queued" && "h-4 rounded-[4px]"),
            )}
          />
        ))}
        {live && <span className="absolute -top-5 -bottom-5 w-[1.5px] bg-foreground/45 transition-[left] duration-1000 ease-linear" style={{ left: `${x(now)}%` }} />}
        {end !== null && <span className="absolute top-2 h-6 w-[1.5px] bg-muted-foreground transition-[left] duration-1000 ease-linear" style={{ left: `${x(end)}%` }} />}
      </div>
      <div className="relative h-5">
        {timed.map((p) => {
          const split = splitOf(p);
          return (
            <span
              key={p.key}
              className={cn("absolute top-1 pl-1 font-mono text-xs whitespace-nowrap tabular-nums", p.ghost ? "text-muted-foreground/60" : "text-muted-foreground", p.open && "font-semibold text-foreground")}
              style={{ left: `${x(p.start)}%` }}
            >
              {timeText(p)}
              {split && <span className={cn("ml-1 font-semibold", splitTone(split.deltaMs))}>{signedClock(split.deltaMs)}</span>}
            </span>
          );
        })}
      </div>
      {live && (
        <div className="relative mt-0.5 h-[18px] text-xs">
          <span className="absolute -translate-x-1/2 font-semibold whitespace-nowrap text-foreground transition-[left] duration-1000 ease-linear" style={{ left: `${x(now)}%` }}>
            now
          </span>
          {showEndTag && (
            <span className="absolute -translate-x-full whitespace-nowrap text-muted-foreground transition-[left] duration-1000 ease-linear" style={{ left: `${x(end!)}%` }}>
              {endTag}
            </span>
          )}
        </div>
      )}
    </div>
  );

  if (!cols) {
    return (
      <div className="select-none" aria-hidden="true">
        {track}
      </div>
    );
  }
  return (
    <div className="grid gap-y-0.5 select-none" aria-hidden="true">
      <div className={LANE_COLS}>
        <div className="min-w-0 pt-5">
          <div className="flex h-[46px] items-center truncate text-[13px] font-bold">This deploy</div>
        </div>
        {track}
        <div className="pt-5 text-right font-mono tabular-nums">
          <div className="flex h-[46px] flex-col items-end justify-center leading-tight">
            <span className="text-[15px] font-semibold">{clock(Math.max(0, (live ? now : runEnd) - line))}</span>
            {open && splits.length > 0 && <span className={cn("text-[11.5px] font-medium", splitTone(versus))}>{signedClock(versus)}</span>}
          </div>
        </div>
      </div>
      {shown.map((lane) => (
        <LaneRow key={lane.key} lane={lane} frame={frame} grid={grid} line={line} now={now} live={live} />
      ))}
    </div>
  );
}

/** Green ahead of the median, red behind, muted level with it. */
function splitTone(deltaMs: number): string {
  return Math.abs(deltaMs) < 1_000 ? "text-muted-foreground" : deltaMs < 0 ? "text-status-success" : "text-status-error";
}

/** Each stage of a successful deploy against its median, then the total. */
function Timeslip({ splits }: { splits: Split[] }) {
  const total = (k: "ms" | "medianMs" | "deltaMs") => splits.reduce((a, s) => a + s[k], 0);
  const cell = "px-3 py-1 text-right font-mono whitespace-nowrap";
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="text-[13px] tabular-nums">
        <caption className="mb-1 text-left text-[13px] font-semibold tracking-[0.08em] text-status-neutral [font-variant-caps:all-small-caps]">Timeslip</caption>
        <thead>
          <tr className="text-xs text-muted-foreground">
            <td />
            {splits.map((s) => (
              <th key={s.stage} scope="col" className="px-3 py-1 text-right font-normal whitespace-nowrap">
                {SHARED_STAGE_LABELS[s.stage]}
              </th>
            ))}
            <th scope="col" className="px-3 py-1 text-right font-normal">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="py-1 pr-6 text-left font-semibold whitespace-nowrap">
              This deploy
            </th>
            {splits.map((s) => (
              <td key={s.stage} className={cn(cell, "font-semibold")}>
                {clock(s.ms)}
              </td>
            ))}
            <td className={cn(cell, "font-bold")}>{clock(total("ms"))}</td>
          </tr>
          <tr className="text-muted-foreground">
            <th scope="row" className="py-1 pr-6 text-left font-normal">
              Median
            </th>
            {splits.map((s) => (
              <td key={s.stage} className={cell}>
                {clock(s.medianMs)}
              </td>
            ))}
            <td className={cell}>{clock(total("medianMs"))}</td>
          </tr>
          <tr>
            <th scope="row" className="py-1 pr-6 text-left font-normal text-muted-foreground">
              Difference
            </th>
            {splits.map((s) => (
              <td key={s.stage} className={cn(cell, "font-semibold", splitTone(s.deltaMs))}>
                {signedClock(s.deltaMs)}
              </td>
            ))}
            <td className={cn(cell, "font-bold", splitTone(total("deltaMs")))}>{signedClock(total("deltaMs"))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Mark({ tone }: { tone: HeadlineTone }) {
  if (tone === "active") return <StatusMark tone="signal" pending />;
  if (tone === "neutral") return <StatusMark tone="neutral" pending />;
  return <StatusMark tone={tone} />;
}

function FactCell({ fact, children }: { fact?: Fact; children?: ReactNode }) {
  return (
    <div className="min-w-0 text-[13.5px]">
      <dt className="mb-0.5 text-[13px] font-semibold tracking-[0.08em] text-status-neutral [font-variant-caps:all-small-caps]">{fact?.label}</dt>
      <dd className="[overflow-wrap:anywhere]">{fact?.value ?? children}</dd>
      {fact?.note && <dd className="text-[12.5px] text-muted-foreground [overflow-wrap:anywhere]">{fact.note}</dd>}
    </div>
  );
}

/** The log, by stage: headers between stages and tabs that narrow it to one. */
function StageLog({
  groups,
  times,
  selected,
  onSelect,
  rollback,
}: {
  groups: LogGroup[];
  times: Partial<Record<string, number>>;
  selected: LogStage | null;
  onSelect: (stage: LogStage | null) => void;
  rollback: boolean;
}) {
  const marked = groups.some((g) => g.stage !== null);
  const stages = LOG_STAGES.filter((s) => s !== "rollingBack" || rollback || groups.some((g) => g.stage === "rollingBack"));
  const time = (stage: SharedStage | null) => (stage && times[stage] !== undefined ? clock(times[stage]!) : null);
  const shown = selected ? groups.filter((g) => g.stage === selected) : groups;
  const lines = shown.flatMap((g) => {
    const head = marked && g.stage && g.stage !== "queued" ? [`── ${SHARED_STAGE_LABELS[g.stage]}${time(g.stage) ? ` ${time(g.stage)}` : ""}`] : [];
    return [
      ...head.map((text) => ({ text, html: `<span class="text-muted-foreground">${text}</span>` })),
      ...g.lines.map((line) => ({ text: line, html: highlightLogLine(line), level: detectLogLevel(line) })),
    ];
  });
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-display text-base font-semibold">Log</h3>
        {marked && (
          <Tabs className="max-w-full min-w-0 overflow-x-auto" value={selected ?? "all"} onValueChange={(v) => onSelect(v === "all" ? null : (v as LogStage))}>
            <TabsList aria-label="Log by stage" className="!h-9 !flex-row">
              <TabsTrigger value="all" className="!w-auto px-2.5 text-[13px]">
                All
              </TabsTrigger>
              {stages.map((s) => {
                const t = time(s);
                const has = groups.some((g) => g.stage === s);
                return (
                  <TabsTrigger key={s} value={s} disabled={!has && !t} className="!w-auto px-2.5 text-[13px]">
                    {SHARED_STAGE_LABELS[s]}
                    {t && <span className="font-mono text-[11px] text-muted-foreground">{t}</span>}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        )}
      </div>
      <TerminalOutput lines={lines} height="h-[340px]" showFilters={false} />
    </div>
  );
}

/**
 * One deploy, zoomed in: the Pipeline row's stages on one track with times, the expected finish at median
 * stage times, the last good run for scale and the log, filtered by clicking a stage.
 */
export function DeployZoom({
  trackUrl,
  row,
  stages,
  view,
  now,
  fallback,
  meta,
  log,
  commit,
  announcement,
  action,
  notice,
  onDismiss,
  children,
}: {
  /** Where the deploy's track is read; null until the deploy has an id. */
  trackUrl: string | null;
  row: { status: string; stage?: string | null; startedAt: Date | string | number | null };
  stages: Record<string, string>;
  view: StreamView;
  now: number | null;
  /** What the right side says before the track loads or without medians. */
  fallback: string | null;
  meta: string | null;
  log: string[];
  commit?: { sha: string | null; message: string | null; by: string | null } | null;
  announcement: string;
  action?: ReactNode;
  notice?: ReactNode;
  onDismiss?: () => void;
  children?: ReactNode;
}) {
  const [selected, setSelected] = useState<LogStage | null>(null);
  const [compare, setCompare] = useState(true);
  const live = row.status === "queued" || row.status === "running";
  const refreshKey = `${row.status}:${view.held ?? ""}:${JSON.stringify(stages)}`;
  const track = useDeployTrack(trackUrl, refreshKey, live);
  const fetched = track?.deploy ?? null;
  const headline = deployHeadline(row, stages, view, { builder: fetched?.builderName ?? null, rollbackRun: fetched?.rollback ?? false });
  // A stage the stream says failed paints red before the row catches up.
  const d = fetched && live && headline.tone === "issue" && !fetched.rollback ? { ...fetched, failed: true, stop: "rolledBack" as const } : fetched;
  // No reference bar for a rollback.
  const previous = fetched?.rollback ? null : (track?.previous ?? null);
  const previousMs = previous ? (previous.finishedAt ?? previous.queuedAt) - previous.queuedAt : null;
  const groups = splitLogByStage(log);
  const at = d && now !== null ? (live ? Math.max(now, d.queuedAt) : now) : null;
  const summary = d && at !== null ? deploySummary(d, headline, { liveAt: liveAt(d, track!.medians, at), previousMs, now: at, fallback }) : fallback ? { main: fallback, sub: null, tone: null } : null;
  const sub = d && at !== null ? deploySubline(d, previousMs, at) : meta;
  const lanes = d && at !== null ? compareLanes(d, { previous, failures: track!.failures, medians: track!.medians }, at) : [];
  const splits = d && at !== null ? stageSplits(d, track!.medians, at) : [];
  const slip = d && at !== null && compare ? timeslip(d, track!.medians, at) : null;
  const versus = splits.length ? `${signedClock(splits.reduce((a, s) => a + s.deltaMs, 0))} vs median` : null;
  const select = (stage: SharedStage) => {
    const next = filterStage(stage, groups);
    setSelected((cur) => (next === null || cur === next ? null : next));
  };

  return (
    <Card variant="surface" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0 p-5 max-sm:p-4">
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] max-sm:grid-cols-1 items-end gap-x-6 gap-y-1">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2.5 font-display text-lg leading-snug font-semibold tracking-[-0.01em]">
            <Mark tone={headline.tone} />
            {headline.title}
          </h2>
          {(sub || action) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {sub && <p className="text-sm text-muted-foreground tabular-nums">{sub}</p>}
              {action}
            </div>
          )}
        </div>
        <div className="flex items-start gap-3">
          {summary && (
            <div className="text-right max-sm:text-left">
              <b className={cn("block text-lg leading-snug font-semibold tracking-[-0.01em] tabular-nums", summary.tone === "issue" && "text-status-error")}>{summary.main}</b>
              {summary.sub && <span className="text-[13px] text-muted-foreground">{summary.sub}</span>}
            </div>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Close"
              className="relative -mt-0.5 rounded p-1 text-muted-foreground after:absolute after:-inset-2 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-brass"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {d && at !== null ? (
        <ZoomTrack d={d} lanes={lanes} open={compare} splits={splits} medians={track!.medians} now={at} selected={selected} onSelect={select} />
      ) : (
        <div aria-hidden="true" className="relative h-[86px]">
          <span className="absolute inset-x-0 top-[42px] h-px bg-foreground/10" />
        </div>
      )}

      {lanes.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            aria-expanded={compare}
            onClick={() => setCompare((v) => !v)}
            className="-ml-1 inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[13px] font-semibold hover:bg-accent focus-visible:outline-2 focus-visible:outline-brass pointer-coarse:min-h-11"
          >
            <DisclosureChevron open={compare} />
            {compare ? "Hide comparison" : "Compare with recent deploys"}
          </button>
          {!compare && versus && <span className="font-mono text-xs text-muted-foreground tabular-nums">{versus}</span>}
        </div>
      )}
      {slip && <Timeslip splits={slip} />}

      {notice && <div className="mt-3">{notice}</div>}

      <dl className="my-5 grid grid-cols-1 gap-4 rounded-xl bg-muted/50 px-4 py-3.5 sm:grid-cols-3">
        <FactCell fact={d && at !== null ? builtOnFact(d, at) : { label: "Built on", value: "…", note: null }} />
        <FactCell
          fact={{
            label: "Commit",
            value: commit?.message || commit?.sha?.slice(0, 7) || "No commit",
            note: [commit?.sha && commit.message ? commit.sha.slice(0, 7) : null, commit?.by].filter(Boolean).join(" · ") || null,
          }}
        />
        <FactCell fact={d ? releaseFact(d, headline, !!track?.previous) : { label: "Release", value: "…", note: null }} />
      </dl>

      {log.length > 0 && (
        <StageLog groups={groups} times={d && at !== null ? stageTimes(d, at) : {}} selected={selected} onSelect={setSelected} rollback={d?.rollback ?? false} />
      )}
      {children}
    </Card>
  );
}
