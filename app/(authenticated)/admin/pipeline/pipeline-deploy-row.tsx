"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusMark } from "@/components/ui/status-dot";
import { toast } from "@/lib/messenger";
import { deployHref } from "@/lib/ui/hrefs";
import type { PipelineDeployDetail } from "@/lib/pipeline/deploy-detail";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import type { PipelineBuilder, PipelineDeploy } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";
import {
  BAR_STAGES,
  barPieces,
  buildMedian,
  clock,
  ghostPieces,
  headText,
  isLive,
  soon,
  span,
  stageTimes,
  waitsForBuilder,
  xPct,
  type BarStage,
} from "./timeline";
import { GhostSpan, Mark, PIECE_CLASS, Span, Track, useHover, type Frame } from "./track";

/** Bars sit this far down the 46px track; the head label rides above. */
const BAR_TOP = 30;

type Tone = "issue" | "warn" | "neutral" | "active";

export function deployTone(d: PipelineDeploy): Tone {
  if (d.failed || d.stop === "rolledBack") return "issue";
  if (!isLive(d)) return "neutral";
  if (d.waiting) return "warn";
  return "active";
}

export function Mark12({ tone }: { tone: Tone }) {
  return tone === "active" ? <StatusMark tone="signal" pending /> : <StatusMark tone={tone} />;
}

/** The builder that refused this deploy lately, if any. */
function refusedBy(d: PipelineDeploy, builders: PipelineBuilder[]): string | null {
  return builders.find((b) => b.refusals.some((r) => r.deploymentId === d.id))?.name ?? null;
}

/** The line under the app name: why it waits, what failed, when it went live, else its org. */
export function statusLine(d: PipelineDeploy, builders: PipelineBuilder[], now: number): { text: string; tone: "warn" | "issue" | null } {
  const failure = d.failure ? ` · ${d.failure}` : "";
  if (d.rollback) return { text: isLive(d) ? "Rolling back · restoring the previous version" : "Rolled back after a crash", tone: "issue" };
  if (d.stop === "rolledBack") return { text: d.stage === "healthcheck" ? `Health check failed${failure}` : `Rolled back${failure}`, tone: "issue" };
  if (d.failed) return { text: `${d.label}${failure}`, tone: "issue" };
  if (d.gone) return { text: "Cancelled", tone: null };
  if (!isLive(d)) return { text: `Live · ${span(now - (d.finishedAt ?? now))} ago`, tone: null };
  if (waitsForBuilder(d)) {
    const place = d.queue ? `${d.queue.position}${d.queue.of ? ` of ${d.queue.of}` : ""}` : null;
    const where = d.next ? `${d.next.name} ${soon(d.next.at, now)}` : "waiting";
    return { text: [place, where].filter(Boolean).join(" · "), tone: "warn" };
  }
  if (d.waiting) return { text: d.queue ? `${d.label} · ${d.queue.position}${d.queue.of ? ` of ${d.queue.of}` : ""}` : d.label, tone: "warn" };
  const refused = refusedBy(d, builders);
  if (refused && d.builder !== null && d.builderName !== refused) return { text: `${refused} refused it · building on ${d.builderName}`, tone: "warn" };
  if (d.fellBack && d.builderName) return { text: `Fell back · building on ${d.builderName}`, tone: "warn" };
  return { text: d.orgName ?? "", tone: null };
}

/** One deploy's straight bar: stages, waits, rollback, the head label at now and ghosts at medians. */
function DeployTrack({ d, frame, medians, lit }: { d: PipelineDeploy; frame: Frame; medians: PipelineMedians; lit: boolean }) {
  const live = isLive(d);
  const pieces = barPieces(d, frame.now);
  const lastEnd = pieces.at(-1)?.end ?? d.queuedAt;
  const outside = !live && lastEnd < frame.now - frame.windowMs;
  const nowX = xPct(frame.now, frame.now, frame.windowMs);
  const headTone = d.stop === "rolledBack" ? "error" : waitsForBuilder(d) ? "warn" : "fg";
  return (
    <Track frame={frame} className="h-[46px]">
      {outside ? (
        <span className="absolute top-1/2 left-1 -translate-y-1/2 font-mono text-[11px] text-muted-foreground/70">Finished {span(frame.now - lastEnd)} ago</span>
      ) : null}
      {pieces.map((p, i) => (
        <Span
          key={p.key}
          frame={frame}
          start={p.start}
          end={p.end}
          top={BAR_TOP}
          title={p.title}
          className={cn(PIECE_CLASS[p.kind], lit && p.kind !== "queued" && "brightness-110")}
          head={live && i === pieces.length - 1 && p.open ? headTone : undefined}
        />
      ))}
      {live && pieces.at(-1)?.open === false ? <Mark frame={frame} at={frame.now} top={BAR_TOP} className="size-1.5 rounded-full bg-foreground" /> : null}
      {!live && !outside ? (
        <Mark frame={frame} at={lastEnd} top={BAR_TOP} className={cn("size-2 rounded-full", d.failed || d.stop === "rolledBack" ? "bg-status-error" : "bg-muted-foreground")} title={d.stop === "rolledBack" ? "Rolled back" : d.failed ? "Failed" : "Live"} />
      ) : null}
      {live ? ghostPieces(d, medians, frame.now).map((g) => <GhostSpan key={g.key} frame={frame} ghost={g} top={BAR_TOP} />) : null}
      {live ? (
        <span className="pointer-events-none absolute top-1 pr-1.5 text-xs font-semibold whitespace-nowrap tabular-nums" style={{ right: `${100 - nowX}%` }}>
          {headText(d, frame.now)}
        </span>
      ) : null}
    </Track>
  );
}

/** Stages mode: one cell per stage, each time against its median. */
function StageCells({ d, now, medians }: { d: PipelineDeploy; now: number; medians: PipelineMedians }) {
  const times = stageTimes(d, now);
  const live = isLive(d);
  const cur = live ? (waitsForBuilder(d) ? "build" : (d.segments.filter((s) => s.end === null).at(-1)?.stage ?? null)) : null;
  const failedAt = d.failed || (d.stop === "rolledBack" && !d.rollback) ? BAR_STAGES.filter((s) => times[s] !== undefined).at(-1) : null;
  return (
    <span className="grid grid-cols-5 items-center gap-2">
      {BAR_STAGES.map((stage) => {
        const med = stage === "build" ? buildMedian(medians, d.appId, d.builder) : (medians.apps[d.appId]?.[stage] ?? null);
        const t = times[stage];
        const bar = (ms: number) => (med ? <span className="col-span-full my-1 h-[3px] overflow-hidden rounded-sm bg-muted dark:bg-secondary"><i className={cn("block h-full", ms > med * 1.5 ? "bg-status-warning" : "bg-st-build")} style={{ width: `${Math.min(100, (ms / med) * 100)}%` }} /></span> : null);
        const host = stage === "build" && d.builderName ? `${d.builderName}${times.wait && times.wait > 10_000 ? ` · waited ${clock(times.wait)}` : ""}` : "";
        if (stage === "build" && waitsForBuilder(d)) {
          return (
            <Cell key={stage} className="bg-status-warning-muted" mark={<StatusMark tone="warn" />} value={clock(times.wait ?? 0)} note={d.next ? `Waiting · ${d.next.name} ${soon(d.next.at, now)}` : "Waiting"} noteClass="text-status-warning" />
          );
        }
        if (stage === failedAt) return <Cell key={stage} className="bg-status-error-muted text-status-error" mark={<StatusMark tone="issue" />} value={clock(t ?? 0)} note={d.failure ?? "Failed"} noteClass="text-status-error" />;
        if (stage === "switch" && d.stop === "rolledBack") return <Cell key={stage} className="bg-status-error-muted text-status-error" value={live ? "Rolling back" : "Rolled back"} note="Old version serving" noteClass="text-status-error" />;
        if (stage === cur) {
          return <Cell key={stage} className="bg-accent" mark={<StatusMark tone="signal" pending />} value={clock(t ?? 0)} extra={bar(t ?? 0)} note={host || (med ? `of about ${clock(med)}` : "")} />;
        }
        if (t !== undefined) return <Cell key={stage} value={clock(t)} extra={bar(t)} note={host} />;
        return <Cell key={stage} value={med ? `~${clock(med)}` : "–"} valueClass="font-medium text-muted-foreground/70" note={host} />;
      })}
    </span>
  );
}

function Cell({ value, note, mark, extra, className, noteClass, valueClass }: { value: string; note?: string; mark?: React.ReactNode; extra?: React.ReactNode; className?: string; noteClass?: string; valueClass?: string }) {
  return (
    <span className={cn("squircle grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5 rounded-lg px-2 py-1.5", className)}>
      {mark}
      <b className={cn("font-mono text-[13px] font-semibold tabular-nums", mark ? "col-start-2" : "col-span-full", valueClass)}>{value}</b>
      {extra}
      {note ? <small className={cn("col-span-full truncate text-[11.5px] text-muted-foreground", noteClass)}>{note}</small> : null}
    </span>
  );
}

export function DeployRow({
  d,
  frame,
  medians,
  builders,
  open,
  onToggle,
  stages,
  settle,
}: {
  d: PipelineDeploy;
  frame: Frame;
  medians: PipelineMedians;
  builders: PipelineBuilder[];
  open: boolean;
  onToggle: () => void;
  stages: boolean;
  settle: "ok" | "error" | undefined;
}) {
  const { lit, bind } = useHover(d.id);
  const status = statusLine(d, builders, frame.now);
  const done = !isLive(d);
  const total = (d.finishedAt ?? frame.now) - d.queuedAt;
  return (
    <div className={cn("squircle rounded-lg", settle === "ok" && "animate-row-flash", settle === "error" && "animate-row-flash-error")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        {...bind}
        className={cn(
          "squircle grid w-full cursor-pointer grid-cols-[var(--lab)_minmax(0,1fr)_var(--tot)] items-center gap-x-3 rounded-lg py-[3px] text-left outline-none hover:bg-row-hover focus-visible:ring-[3px] focus-visible:ring-ring/50",
          (open || lit) && "bg-row-hover",
        )}
      >
        <span className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)] items-center gap-x-2 pl-1.5">
          <Mark12 tone={deployTone(d)} />
          <span className={cn("truncate font-semibold", done && "font-medium text-muted-foreground", lit && "underline decoration-brass underline-offset-[3px]")}>{d.appName}</span>
          <span className={cn("col-start-2 truncate text-[12.5px] text-muted-foreground", status.tone === "warn" && "text-status-warning", status.tone === "issue" && "text-status-error")}>
            {status.text || " "}
          </span>
        </span>
        {stages ? <StageCells d={d} now={frame.now} medians={medians} /> : <DeployTrack d={d} frame={frame} medians={medians} lit={lit} />}
        <span className="pr-2 text-right font-mono text-[12.5px] tabular-nums">{clock(total)}</span>
      </button>
      {open ? <DrillIn d={d} frame={frame} medians={medians} /> : null}
    </div>
  );
}

type RailRow = { key: string; name: string; state: "done" | "now" | "next" | "wait" | "fail" | "skip"; time: string; note?: string; noteTone?: "warn" | "issue"; chip?: string };

const RAIL_STAGES = ["queued", "prepare", "build", "start", "health", "switch", "live"] as const;
const RAIL_NAMES: Record<(typeof RAIL_STAGES)[number], string> = { queued: "Queued", prepare: "Prepare", build: "Build", start: "Start", health: "Health check", switch: "Switch traffic", live: "Live" };

const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** The rail: every stage on one line, the host a chip on Build, waits and failures as notes. */
export function railRows(d: PipelineDeploy, now: number, medians: PipelineMedians, detail: PipelineDeployDetail | null): RailRow[] {
  const live = isLive(d);
  const times = stageTimes(d, now);
  const queued = d.segments.find((s) => s.stage === "queued");
  const reached = new Set(d.segments.map((s) => s.stage));
  const cur = live ? (waitsForBuilder(d) ? "build" : (d.segments.filter((s) => s.end === null).at(-1)?.stage ?? null)) : null;
  const rolledBack = d.stop === "rolledBack" && !d.rollback;
  const failedAt = d.failed || rolledBack ? RAIL_STAGES.filter((s) => s !== "queued" && reached.has(s)).at(-1) : null;
  const rows: RailRow[] = [];
  for (const stage of RAIL_STAGES) {
    const med = stage === "build" ? buildMedian(medians, d.appId, d.builder) : stage === "queued" || stage === "live" ? null : (medians.apps[d.appId]?.[stage] ?? null);
    let state: RailRow["state"] = reached.has(stage) ? "done" : "next";
    if (stage === cur || (stage === "queued" && live && d.stop === "queue")) state = "now";
    if (!live && d.status === "success") state = "done";
    if (stage === failedAt) state = "fail";
    if (rolledBack && (stage === "switch" || stage === "live") && !reached.has(stage)) state = "skip";
    if (d.failed && state === "next") state = "skip";
    const ms = stage === "queued" ? (queued ? (queued.end ?? now) - queued.start : 0) : (times[stage as BarStage] ?? 0);
    const time = state === "done" || state === "fail" || state === "now" ? (stage === "live" ? "" : clock(ms)) : state === "next" && med ? `~${clock(med)}` : "";
    const row: RailRow = { key: stage, name: RAIL_NAMES[stage], state, time };
    if (stage === "build") {
      if (d.builderName) row.chip = `on ${d.builderName}`;
      if (waitsForBuilder(d)) {
        row.state = "wait";
        row.time = clock(times.wait ?? 0);
        row.note = `Waiting for a builder${d.queue ? ` · ${d.queue.position}${d.queue.of ? ` of ${d.queue.of}` : ""} in line` : ""}${d.next ? ` · ${d.next.name} ${soon(d.next.at, now)}` : ""}`;
        row.noteTone = "warn";
      } else if (d.fellBack) {
        row.note = detail?.fallbackReason ? `Fell back: ${detail.fallbackReason}` : "Fell back from a build target";
        row.noteTone = "warn";
      } else if (d.transfer) {
        const size = detail?.transferBytes ? `${mb(detail.transferBytes)} ` : "";
        row.note = `Image back over ${d.transfer.via === "ssh" ? "SSH" : "the registry"}${d.transfer.ms !== null ? ` · ${size}in ${clock(d.transfer.ms)}` : ""}`;
      } else if (times.wait && times.wait > 1000) {
        row.note = `Waited ${clock(times.wait)} for a builder`;
      }
    }
    if (stage === failedAt && d.failure) {
      row.note = d.failure;
      row.noteTone = "issue";
    }
    rows.push(row);
    if (stage === failedAt && rolledBack) rows.push({ key: "back", name: "Rolled back", state: "fail", time: "", note: "The old version kept serving", noteTone: "issue" });
  }
  if (d.rollback) {
    return [
      rows[0],
      { key: "back", name: live ? "Rolling back" : "Rolled back", state: live ? "now" : "done", time: clock((d.finishedAt ?? now) - d.stageSince), note: "Restoring the previous version", noteTone: "issue" },
    ];
  }
  return rows;
}

const DOT: Record<RailRow["state"], string> = {
  done: "border-muted-foreground bg-muted-foreground",
  now: "border-foreground bg-card shadow-[0_0_0_3px_color-mix(in_oklch,var(--foreground)_10%,transparent)]",
  next: "border-foreground/20 bg-card",
  wait: "border-status-warning bg-status-warning-muted",
  fail: "border-status-error bg-status-error",
  skip: "border-dashed border-foreground/20 bg-card",
};

function useDeployDetail(id: string, live: boolean) {
  const [detail, setDetail] = useState<PipelineDeployDetail | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/admin/pipeline/deploys/${id}`);
    if (res.ok) setDetail((await res.json()) as PipelineDeployDetail);
  }, [id]);
  useEffect(() => {
    const first = setTimeout(() => void load().catch(() => {}), 0);
    const t = live ? setInterval(() => void load().catch(() => {}), 3000) : null;
    return () => {
      clearTimeout(first);
      if (t) clearInterval(t);
    };
  }, [load, live]);
  return { detail, reload: load };
}

function DrillIn({ d, frame, medians }: { d: PipelineDeploy; frame: Frame; medians: PipelineMedians }) {
  const live = isLive(d);
  const { detail, reload } = useDeployDetail(d.id, live);
  const [busy, setBusy] = useState(false);
  const rows = railRows(d, frame.now, medians, detail);
  const median = medians.apps[d.appId];
  const toLive = median ? (["prepare", "build", "start", "health", "switch"] as const).reduce<number | null>((sum, s) => {
    const m = s === "build" ? buildMedian(medians, d.appId, d.builder) : median[s];
    return sum === null || m === undefined || m === null ? null : sum + m;
  }, 0) : null;

  const act = async (method: "DELETE" | "POST") => {
    setBusy(true);
    try {
      const res = await fetch(method === "DELETE" ? `/api/v1/admin/pipeline/deploys/${d.id}` : `/api/v1/admin/pipeline/deploys/${d.id}/redeploy`, { method });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
      toast.success(method === "DELETE" ? `Cancelling ${d.appName}` : `Queued a deploy of ${d.appName}`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const slug = detail?.appSlug ?? d.appSlug;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-5 px-2 pt-3 pb-5 pl-[26px]">
      <ol className="m-0 list-none p-0">
        {rows.map((r, i) => (
          <li key={r.key} className="relative grid grid-cols-[18px_minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 pb-3">
            {i < rows.length - 1 ? <span aria-hidden className={cn("absolute top-3.5 -bottom-0.5 left-2 w-0.5", r.state === "done" ? "bg-muted-foreground" : "bg-foreground/20")} /> : null}
            <span aria-hidden className={cn("z-[1] mt-[3px] ml-[3px] size-3 rounded-full border-2", DOT[r.state])} />
            <span className={cn("font-semibold", (r.state === "next" || r.state === "skip") && "font-normal text-muted-foreground")}>
              {r.name}
              {r.chip ? <span className="ml-2 inline-flex items-center rounded-full px-2 py-px align-[1px] text-[11.5px] font-medium ring-1 ring-foreground/20 ring-inset">{r.chip}</span> : null}
            </span>
            <span className={cn("text-right font-mono text-xs tabular-nums text-muted-foreground", r.state === "next" && "text-muted-foreground/70")}>{r.time}</span>
            {r.note ? <span className={cn("col-start-2 col-end-4 text-[12.5px] text-muted-foreground", r.noteTone === "warn" && "text-status-warning", r.noteTone === "issue" && "text-status-error")}>{r.note}</span> : null}
          </li>
        ))}
      </ol>
      <div className="min-w-0">
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">Commit</dt>
          <dd className="m-0 min-w-0 truncate">{detail?.gitSha ? <><span className="font-mono">{detail.gitSha.slice(0, 7)}</span> {detail.gitMessage?.split("\n")[0]}</> : <span className="text-muted-foreground">{detail ? "None" : "…"}</span>}</dd>
          <dt className="text-muted-foreground">Org</dt>
          <dd className="m-0">{[d.orgName, detail?.envName].filter(Boolean).join(" · ") || "–"}</dd>
          <dt className="text-muted-foreground">Built on</dt>
          <dd className="m-0">{d.builderName ? `${d.builderName}${d.fellBack ? " (fell back)" : ""}` : <span className="text-muted-foreground">Not yet</span>}</dd>
          {detail?.buildPeakBytes ? (
            <>
              <dt className="text-muted-foreground">Build memory</dt>
              <dd className="m-0 font-mono tabular-nums">{gb(detail.buildPeakBytes)} peak</dd>
            </>
          ) : null}
          {detail?.imageBytes ? (
            <>
              <dt className="text-muted-foreground">Image</dt>
              <dd className="m-0 font-mono tabular-nums">{mb(detail.imageBytes)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Total</dt>
          <dd className="m-0">
            <span className="font-mono tabular-nums">{clock((d.finishedAt ?? frame.now) - d.queuedAt)}</span>
            {toLive ? <span className="text-muted-foreground"> · median {clock(toLive)}</span> : null}
          </dd>
        </dl>
        {detail && detail.log.length > 0 ? (
          <pre className="squircle mt-3 mb-0 overflow-hidden rounded-md bg-background-deep px-3 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {detail.log.map((l, i) => (
              <span key={i} className={cn("block", /\b(ERROR|failed|refused)\b/i.test(l) && "text-status-error")}>{l}</span>
            ))}
          </pre>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {slug ? (
            <Button asChild size="sm">
              <Link href={deployHref(slug, d.id)}>Open deploy</Link>
            </Button>
          ) : null}
          {detail?.cancellable ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("DELETE")}>
              Cancel
            </Button>
          ) : null}
          {detail?.redeployable ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("POST")}>
              Redeploy
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
