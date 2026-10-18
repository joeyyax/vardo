"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { deploySlotLine } from "@/lib/pipeline/deploy-slot-line";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import type { PipelineDeploy, PipelineSnapshot } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";
import { DeployRow } from "./pipeline-deploy-row";
import { WINDOWS, axisTicks, builderLanes, isLive, waitsForBuilder, xPct, type Lane, type WindowKey } from "./timeline";
import { HoverContext, Mark, Span, Track, useHover, type Frame } from "./track";

/** Finished rows shown beside in-flight ones, and with nothing in flight. */
const FINISHED_WITH_LIVE = 3;
const FINISHED_ALONE = 5;
const FINISHED_MAX = 20;

/** Every finished deploy we know of, newest first, history merged in. */
function finishedDeploys(snapshot: PipelineSnapshot, history: PipelineDeploy[]): PipelineDeploy[] {
  const byId = new Map<string, PipelineDeploy>();
  for (const d of [...history, ...snapshot.recent, ...snapshot.deploys.filter((x) => !isLive(x))]) byId.set(d.id, d);
  return [...byId.values()].filter((d) => d.finishedAt !== null).sort((a, b) => b.finishedAt! - a.finishedAt!);
}

function matches(d: PipelineDeploy, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [d.appName, d.orgName, d.builderName].some((v) => v?.toLowerCase().includes(needle));
}

/** Ids that just moved from in flight to finished, with how they settled; each clears after its flash. */
function useSettled(deploys: PipelineDeploy[]): Map<string, "ok" | "error"> {
  const prev = useRef<Set<string>>(new Set());
  const [settled, setSettled] = useState<Map<string, "ok" | "error">>(new Map());
  useEffect(() => {
    const liveNow = new Set(deploys.filter(isLive).map((d) => d.id));
    const done = deploys.filter((d) => prev.current.has(d.id) && !liveNow.has(d.id));
    prev.current = liveNow;
    if (done.length === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setSettled((m) => new Map([...m, ...done.map((d): [string, "ok" | "error"] => [d.id, d.status === "success" ? "ok" : "error"])]));
    const t = setTimeout(() => setSettled((m) => new Map([...m].filter(([id]) => !done.some((d) => d.id === id)))), 2000);
    return () => clearTimeout(t);
  }, [deploys]);
  return settled;
}

function Legend() {
  const sw = (cls: string) => <i aria-hidden className={cn("inline-block h-2.5 w-4 shrink-0 rounded-[2px]", cls)} />;
  const arrow = <span aria-hidden className="-mx-0.5 text-muted-foreground/60">›</span>;
  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11.5px] text-muted-foreground" aria-label="Key">
      <span className="inline-flex items-center gap-1.5">{sw("!h-0.5 bg-muted-foreground/60")}Queued</span>
      {arrow}
      <span className="inline-flex items-center gap-1.5">{sw("bg-st-prep")}Prepare</span>
      {arrow}
      <span className="inline-flex items-center gap-1.5">{sw("bg-st-build")}Build</span>
      {arrow}
      <span className="inline-flex items-center gap-1.5">{sw("bg-st-start")}Start</span>
      {arrow}
      <span className="inline-flex items-center gap-1.5">{sw("bg-st-health")}Health check</span>
      {arrow}
      <span className="inline-flex items-center gap-1.5">{sw("bg-st-switch")}Switch traffic</span>
      {arrow}
      <span className="inline-flex items-center gap-1.5"><i aria-hidden className="size-2 rounded-full bg-muted-foreground" />Live</span>
      <span aria-hidden className="mx-1 h-3.5 w-px bg-border" />
      <span className="inline-flex items-center gap-1.5">{sw("hatch-warn")}Waiting</span>
      <span className="inline-flex items-center gap-1.5">{sw("ring-1 ring-inset ring-foreground/20")}Expected</span>
      <span className="inline-flex items-center gap-1.5">{sw("bg-status-error")}Failed</span>
    </div>
  );
}

function Axis({ frame, stages }: { frame: Frame; stages: boolean }) {
  if (stages) {
    return (
      <div className="grid grid-cols-[var(--lab)_minmax(0,1fr)_var(--tot)] items-end gap-x-3 pb-1">
        <span />
        <span className="grid grid-cols-5 gap-2 px-2 type-label text-muted-foreground/70">
          <span>Prepare</span>
          <span>Build</span>
          <span>Start</span>
          <span>Health check</span>
          <span>Switch traffic</span>
        </span>
        <span className="pr-2 text-right font-mono text-[11px] text-muted-foreground">Total</span>
      </div>
    );
  }
  const label = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/ [AP]M$/, "");
  return (
    <div className="grid h-5 grid-cols-[var(--lab)_minmax(0,1fr)_var(--tot)] items-center gap-x-3 font-mono text-[11px] text-muted-foreground/70">
      <span />
      <div className="relative h-full">
        {axisTicks(frame.now, frame.windowMs).map((t) => (
          <span key={t.at} className="absolute top-0.5 -translate-x-1/2 whitespace-nowrap transition-[left] duration-1000 ease-linear" style={{ left: `${t.x}%` }}>
            {label(t.at)}
          </span>
        ))}
        <span className="absolute top-0.5 -translate-x-1/2 font-semibold text-foreground" style={{ left: `${xPct(frame.now, frame.now, frame.windowMs)}%` }}>
          now
        </span>
      </div>
      <span className="pr-2 text-right text-muted-foreground">Total</span>
    </div>
  );
}

function LaneBarView({ frame, bar }: { frame: Frame; bar: Lane["bars"][number] }) {
  const { lit, bind } = useHover(bar.deployId);
  const cls =
    bar.kind === "own"
      ? "hatch-muted h-5 rounded-md ring-1 ring-inset ring-border"
      : bar.kind === "next"
        ? "h-5 rounded-md bg-transparent ring-1 ring-inset ring-status-warning-edge"
        : cn("h-5 rounded-md ring-1 ring-inset", bar.open ? "bg-st-prep ring-st-build" : "bg-muted ring-border dark:bg-secondary");
  return (
    <Span
      frame={frame}
      start={bar.start}
      end={bar.end}
      title={bar.title}
      className={cn(cls, "shadow-none")}
      lit={lit}
      bind={{ ...bind, tabIndex: bar.deployId ? -1 : undefined }}
      label={bar.label}
      labelClass={bar.kind === "next" ? "text-status-warning" : bar.kind === "own" ? "text-muted-foreground" : "text-foreground"}
    />
  );
}

function BuilderLanes({ snapshot, frame, deploys, medians }: { snapshot: PipelineSnapshot; frame: Frame; deploys: PipelineDeploy[]; medians: PipelineMedians }) {
  const lanes = builderLanes(snapshot.builders, deploys, medians, frame.now, frame.windowMs);
  return (
    <>
      {lanes.map((lane) => {
        const b = lane.builder;
        return (
          <div key={`${b.id}-${lane.index}`} className="grid min-h-[26px] grid-cols-[var(--lab)_minmax(0,1fr)_var(--tot)] items-center gap-x-3">
            <span className="truncate text-[13px] text-muted-foreground">
              {lane.index === 0 ? (
                <>
                  <b className="font-semibold text-foreground">{b.name}</b>
                  {lanes.filter((l) => l.builder.id === b.id).length > 1 ? " · 1" : ""}
                  {b.online === false ? <span className="text-status-warning"> · offline</span> : null}
                </>
              ) : (
                `${b.name} · ${lane.index + 1}`
              )}
            </span>
            <Track frame={frame} className="h-[26px]">
              {lane.bars.map((bar) => (
                <LaneBarView key={bar.key} frame={frame} bar={bar} />
              ))}
              {lane.marks.map((m) => (
                <Mark key={m.key} frame={frame} at={m.at} title={m.title} className="z-[2] grid size-3.5 place-items-center rounded-full bg-card text-[13px] leading-none font-bold text-status-error before:content-['×']" />
              ))}
            </Track>
            <span className="pr-2 text-right font-mono text-xs whitespace-nowrap text-muted-foreground">{lane.index === 0 ? `${b.holders.length} of ${b.slots}` : ""}</span>
          </div>
        );
      })}
    </>
  );
}

/** A section label; every one after the first sits under a rule. */
function Group({ label, first = false }: { label: string; first?: boolean }) {
  return <div className={cn("mt-2.5 mb-0.5 border-t pt-2 type-label text-muted-foreground", first && "mt-1 border-t-0")}>{label}</div>;
}

export function PipelineDeploys({
  snapshot,
  now,
  window,
  onWindow,
  stages,
  onStages,
  history,
  filter,
  onClearFilter,
  open,
  onToggle,
}: {
  snapshot: PipelineSnapshot;
  now: number;
  window: WindowKey;
  onWindow: (w: WindowKey) => void;
  stages: boolean;
  onStages: (on: boolean) => void;
  history: { recent: PipelineDeploy[]; medians: PipelineMedians } | null;
  filter: string;
  onClearFilter: () => void;
  open: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const frame: Frame = { now, windowMs: WINDOWS[window] };
  const medians = useMemo<PipelineMedians>(
    () => ({ apps: { ...history?.medians.apps, ...snapshot.medians.apps }, builders: snapshot.medians.builders }),
    [history, snapshot.medians],
  );
  const live = snapshot.deploys.filter(isLive);
  const finishedAll = finishedDeploys(snapshot, history?.recent ?? []);
  const settled = useSettled(snapshot.deploys);

  const inFlight = live.filter((d) => matches(d, filter));
  const inWindow = finishedAll.filter((d) => d.finishedAt! >= now - frame.windowMs);
  const finished = finishedAll
    .filter((d) => matches(d, filter))
    .slice(0, Math.min(FINISHED_MAX, Math.max(live.length ? FINISHED_WITH_LIVE : FINISHED_ALONE, inWindow.length)));
  const waiting = live.filter(waitsForBuilder).length;
  const nothing = live.length === 0 && inWindow.length === 0;

  return (
    <HoverContext.Provider value={{ id: hover, set: setHover }}>
      <Card variant="surface" className="p-5" aria-label="Deploys">
        <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <h2 className="type-h4">Deploys</h2>
          <span className="font-mono text-xs text-muted-foreground">
            {live.length} in flight
            {waiting ? (
              <>
                {" · "}
                <span className="text-status-warning">{waiting} waiting for a builder</span>
              </>
            ) : null}
            {" · "}
            {deploySlotLine(snapshot)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {!stages ? (
              <Tabs value={window} onValueChange={(v) => onWindow(v as WindowKey)}>
                <TabsList aria-label="Window">
                  {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
                    <TabsTrigger key={w} value={w} className="px-2.5 text-[13px]">
                      {w}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            ) : null}
            <Tabs value={stages ? "stages" : "time"} onValueChange={(v) => onStages(v === "stages")}>
              <TabsList aria-label="Rows">
                <TabsTrigger value="time" className="px-2.5 text-[13px]">
                  Time
                </TabsTrigger>
                <TabsTrigger value="stages" className="px-2.5 text-[13px]">
                  Stages
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
        {!stages ? <Legend /> : null}
        <div className="[--lab:248px] [--tot:56px]">
          <Axis frame={frame} stages={stages} />
          <div className="mt-1.5 border-t" />
          {!stages ? (
            <>
              <Group label="Builders" first />
              <BuilderLanes snapshot={snapshot} frame={frame} deploys={[...live, ...finishedAll]} medians={medians} />
            </>
          ) : null}
          <Group label={live.length ? "In flight" : "Recent"} first={stages} />
          {inFlight.map((d) => (
            <DeployRow key={d.id} d={d} frame={frame} medians={medians} builders={snapshot.builders} open={open.has(d.id)} onToggle={() => onToggle(d.id)} stages={stages} settle={settled.get(d.id)} />
          ))}
          {live.length > 0 && finished.length > 0 ? <Group label="Finished" /> : null}
          {finished.map((d) => (
            <DeployRow key={d.id} d={d} frame={frame} medians={medians} builders={snapshot.builders} open={open.has(d.id)} onToggle={() => onToggle(d.id)} stages={stages} settle={settled.get(d.id)} />
          ))}
          {filter && inFlight.length === 0 && finished.length === 0 ? (
            <p className="py-1.5 text-[13px] text-muted-foreground">
              No deploys match.{" "}
              <Button size="xs" variant="ghost" onClick={onClearFilter}>
                Clear filter
              </Button>
            </p>
          ) : null}
          {nothing && !stages && window !== "6h" && !filter ? (
            <p className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
              {finishedAll.length ? `Nothing in the last ${window}.` : "No deploys yet."}
              {finishedAll.length ? (
                <Button size="xs" variant="outline" onClick={() => onWindow("6h")}>
                  Show 6h
                </Button>
              ) : null}
            </p>
          ) : null}
        </div>
      </Card>
    </HoverContext.Provider>
  );
}
