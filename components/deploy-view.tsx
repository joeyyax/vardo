"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { StatusMark } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import { barPieces, clock, isLive, stageTimes, textWidth, xPct, zoomFrame, zoomGrid, zoomRange } from "@/app/(authenticated)/admin/pipeline/timeline";
import { GHOST_CLASS, PIECE_CLASS, Span } from "@/app/(authenticated)/admin/pipeline/track";
import type { DeployTrack } from "@/lib/pipeline/read";
import type { PipelineDeploy } from "@/lib/pipeline/types";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import { SHARED_STAGE_LABELS, type SharedStage } from "@/lib/ui/deploy-stage";
import type { DeployView as StreamView } from "@/lib/ui/deploy-wait";
import { cn } from "@/lib/utils";
import {
  LOG_STAGES,
  builtOnFact,
  deployHeadline,
  deploySubline,
  deploySummary,
  filterStage,
  liveAt,
  releaseFact,
  splitLogByStage,
  timeOfDay,
  viewPieces,
  type Fact,
  type HeadlineTone,
  type LogGroup,
  type LogStage,
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

/** The run on one track: stages above, times below, now and the expected finish, the last good run under it. */
function ZoomTrack({
  d,
  previous,
  medians,
  now,
  selected,
  onSelect,
}: {
  d: PipelineDeploy;
  previous: PipelineDeploy | null;
  medians: PipelineMedians;
  now: number;
  selected: LogStage | null;
  onSelect: (stage: SharedStage) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const pieces = viewPieces(d, medians, now);
  const real = pieces.filter((p) => !p.ghost);
  const ghosts = pieces.filter((p) => p.ghost);
  const previousMs = previous ? (previous.finishedAt ?? now) - previous.queuedAt : null;
  const range = zoomRange(d, real, ghosts, previousMs, now);
  const frame = zoomFrame(range.start, range.end);
  const x = (t: number) => xPct(t, frame.now, frame.windowMs);
  const px = (ms: number) => (ms / (range.end - range.start)) * width;
  const live = isLive(d);
  const end = live ? liveAt(d, medians, now) : null;

  // The open stage's name may run on over its own remainder ghost.
  const room = (p: ViewPiece, i: number) => {
    const next = pieces[i + 1];
    return px(p.end - p.start) + (p.open && next?.ghost && next.label === "" && next.kind === p.kind ? px(next.end - next.start) : 0);
  };
  const named = width > 0 ? pieces.filter((p, i) => p.label && room(p, i) >= textWidth(p.label, LABEL_FONT) + 8) : [];
  const timeText = (p: ViewPiece) => `${p.ghost ? "~" : ""}${clock(p.end - p.start)}`;
  const timed = width > 0 ? pieces.filter((p) => p.kind !== "queued" && px(p.end - p.start) >= textWidth(timeText(p), TIME_FONT) + 10) : [];

  const prevOffset = previous ? d.queuedAt - previous.queuedAt : 0;
  const prevPieces = previous ? barPieces(previous, now).filter((p) => p.kind !== "queued") : [];
  const prevEnd = previous && previousMs !== null ? d.queuedAt + previousMs : null;
  const prevLabel = previousMs !== null ? `Last deploy ${clock(previousMs)}` : "";
  const prevLabelAfter = prevEnd !== null && width > 0 && px(range.end - prevEnd) >= textWidth(prevLabel, TAG_FONT) + 12;
  const endTag = end !== null ? `Live at about ${timeOfDay(end)}` : "";
  const showEndTag = end !== null && width > 0 && px(end - now) >= textWidth(endTag, TAG_FONT) / 2 + 28;

  return (
    <div ref={ref} className="relative select-none" aria-hidden="true">
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
        {zoomGrid(range.start, range.end).map((t) => (
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
        {timed.map((p) => (
          <span
            key={p.key}
            className={cn("absolute top-1 pl-1 font-mono text-xs whitespace-nowrap tabular-nums", p.ghost ? "text-muted-foreground/60" : "text-muted-foreground", p.open && "font-semibold text-foreground")}
            style={{ left: `${x(p.start)}%` }}
          >
            {timeText(p)}
          </span>
        ))}
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
      {previous && (
        <div className={cn("relative mt-0.5", prevLabelAfter ? "h-[22px]" : "h-[38px]")}>
          {prevPieces.map((p) => (
            <span
              key={p.key}
              className={cn("absolute top-[9px] h-1 rounded-[2px] opacity-45 shadow-[1px_0_0_var(--card),-1px_0_0_var(--card)]", PIECE_CLASS[p.kind].replace(/\bh-\S+/g, ""))}
              style={{ left: `${x(p.start + prevOffset)}%`, width: `${Math.max(0, x(p.end + prevOffset) - x(p.start + prevOffset))}%` }}
            />
          ))}
          {prevEnd !== null && (
            <span
              className={cn("absolute text-xs whitespace-nowrap text-muted-foreground", prevLabelAfter ? "top-[3px] pl-2" : "top-[18px] -translate-x-full")}
              style={{ left: `${x(prevEnd)}%` }}
            >
              {prevLabel}
            </span>
          )}
        </div>
      )}
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
        <ZoomTrack d={d} previous={previous} medians={track!.medians} now={at} selected={selected} onSelect={select} />
      ) : (
        <div aria-hidden="true" className="relative h-[86px]">
          <span className="absolute inset-x-0 top-[42px] h-px bg-foreground/10" />
        </div>
      )}

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
