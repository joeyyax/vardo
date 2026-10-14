"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { DEPLOY_STAGE_KEYS, ROLLBACK_STAGE_KEYS, STAGE_LABELS } from "@/lib/ui/deploy-stage";
import {
  applyWait,
  deployCardText,
  deployClockOf,
  NO_WAIT,
  parseWaitEvent,
  queuedStep,
  streamView,
  type DeployView,
  type WaitState,
} from "@/lib/ui/deploy-wait";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import { quietLinkClass } from "@/components/entity-link";
import { cn } from "@/lib/utils";

type StageStatus = "running" | "success" | "failed" | "skipped";

export type DeployStream = { stages: Record<string, StageStatus>; wait: WaitState };

/** Phases and waits of an app's deploy, from its log stream. Replays from the start on connect. */
export function useDeployStream(orgId: string, appId: string, { deploymentId, enabled = true }: { deploymentId?: string; enabled?: boolean } = {}) {
  const key = `${appId}:${deploymentId ?? ""}`;
  const [stream, setStream] = useState<DeployStream & { key: string }>({ key, stages: {}, wait: NO_WAIT });
  if (stream.key !== key) setStream({ key, stages: {}, wait: NO_WAIT });

  useEffect(() => {
    if (!enabled) return;
    const query = deploymentId ? `?deploymentId=${encodeURIComponent(deploymentId)}` : "";
    const es = new EventSource(`/api/v1/organizations/${orgId}/apps/${appId}/deploy/stream${query}`);
    es.addEventListener("stage", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { stage?: string; status?: StageStatus };
        if (data.stage && data.status) setStream((s) => ({ ...s, stages: { ...s.stages, [data.stage!]: data.status! } }));
      } catch {
        /* malformed event */
      }
    });
    es.addEventListener("wait", (event) => {
      try {
        const data = parseWaitEvent(JSON.parse((event as MessageEvent).data));
        if (data) setStream((s) => ({ ...s, wait: applyWait(s.wait, data) }));
      } catch {
        /* malformed event */
      }
    });
    es.addEventListener("done", () => es.close());
    es.onerror = () => es.close();
    return () => es.close();
  }, [orgId, appId, deploymentId, enabled]);

  return stream;
}

/** The clock, ticking. Null until mounted so server and client render alike. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export type StripStep = { key: string; label: string; state: "done" | "held" | "now" | "failed" | "todo" };

/** Queued, then the phases, with the held one marked. A rollback has no Queued step. */
export function deploySteps(view: DeployView, stages: Record<string, string>): StripStep[] {
  const rollback = ROLLBACK_STAGE_KEYS.some((k) => stages[k]);
  const keys = (rollback ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS).filter((k) => k !== "cleanup" && stages[k] !== "skipped");
  const first = queuedStep(view);
  const current = keys.findIndex((k) => stages[k] === "running" || stages[k] === "failed");
  return [
    ...(rollback ? [] : [{ key: "queued", label: first.label, state: first.state }]),
    ...keys.map((k, i): StripStep => ({
      key: k,
      label: STAGE_LABELS[k],
      state:
        stages[k] === "success"
          ? "done"
          : i === current
            ? stages[k] === "failed"
              ? "failed"
              : view.held === k
                ? "held"
                : "now"
            : "todo",
    })),
  ];
}

/** The phases a row's stage implies, until the stream replays them: every one before it done, it running. */
export function stagesUpTo(stage: string | null | undefined): Record<string, string> {
  const keys = ROLLBACK_STAGE_KEYS.includes(stage ?? "") ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS;
  const at = stage ? keys.indexOf(stage) : -1;
  return at < 0 ? {} : Object.fromEntries(keys.slice(0, at + 1).map((k, i) => [k, i === at ? "running" : "success"]));
}

const SPOKEN: Record<StripStep["state"], string> = { done: ", done", now: ", in progress", held: ", queued", failed: ", failed", todo: "" };

/** One phase: a check when done, a ring while in flight or held, a hollow dot ahead. */
function StepMark({ state, warn }: { state: StripStep["state"]; warn: boolean }) {
  if (state === "done") return <Check aria-hidden="true" className="size-3 shrink-0 text-status-success" />;
  if (state === "failed") return <X aria-hidden="true" className="size-3 shrink-0 text-status-error" />;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        state === "todo" && "shadow-[inset_0_0_0_1.5px_currentColor] opacity-60",
        state === "now" && "shadow-[inset_0_0_0_2px_currentColor] motion-safe:animate-pulse",
        state === "held" && cn("shadow-[inset_0_0_0_2px_currentColor]", warn && "text-status-warning"),
      )}
    />
  );
}

/** What a screen reader hears as the run moves, empty until a phase lands so it stays quiet on mount. */
function announcement(view: DeployView, steps: StripStep[], stages: Record<string, string>): string {
  const rollback = ROLLBACK_STAGE_KEYS.some((k) => stages[k]);
  const noun = rollback ? "Rollback" : "Deployment";
  const failed = steps.find((s) => s.state === "failed");
  if (failed) return `${noun} failed at ${failed.label} stage`;
  const phases = steps.filter((s) => s.key !== "queued");
  if (Object.keys(stages).length > 0 && phases.every((s) => s.state === "done")) return `${noun} completed successfully`;
  if (view.tone !== "info") return view.label;
  const now = steps.find((s) => s.state === "now" && s.key !== "queued");
  return now ? `${rollback ? "Rolling back" : "Deploying"}: ${now.label} in progress` : "";
}

/**
 * A deploy in flight: the phase strip, a bar against the last good deploy and the time left.
 * `full` names every phase and adds the time spent and the log; `compact` names only the phase in flight.
 */
export function DeployProgress({
  variant,
  stages: streamed,
  wait: streamedWait,
  row,
  typicalMs,
  href,
  log,
  expanded = false,
  onToggleExpand,
  cancelling = false,
  onStartNext,
}: {
  variant: "full" | "compact";
  stages: Record<string, string>;
  wait: WaitState;
  /** The deploy row, which speaks for the deploy until the stream does. */
  row: { status: string; stage?: string | null; held?: boolean; startedAt: Date | string | number | null };
  /** Run time of the last successful deploy. Null when there is none. */
  typicalMs: number | null;
  /** Compact: where "Open" goes. */
  href?: string;
  /** Full: the deploy log, shown on expand. */
  log?: string[];
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Full: a cancel was signaled and the engine is finishing its current phase. */
  cancelling?: boolean;
  /** Instance admins: moves a deploy waiting in line to the front. Resolves true once it has. */
  onStartNext?: () => Promise<boolean>;
}) {
  const now = useNow(1000);
  const [confirm, setConfirm] = useState(false);
  const [moving, setMoving] = useState(false);
  // The wait a successful Start next moved to the front, read as first until the stream says so.
  const [movedSince, setMovedSince] = useState<number | null>(null);
  const wait = movedSince !== null && streamedWait.current?.since === movedSince ? { ...streamedWait, current: { ...streamedWait.current, ahead: 0 } } : streamedWait;
  const stages = Object.keys(streamed).length > 0 || row.status !== "running" ? streamed : stagesUpTo(row.stage);
  const view = streamView({ wait, stages }, { status: row.status, stage: row.stage, request: { held: row.held } }, now);
  const clock = now !== null && row.startedAt !== null ? deployClockOf({ wait, stages }, { startedAt: row.startedAt, status: row.status, now }) : null;
  const text = clock ? deployCardText(view, clock, typicalMs) : null;
  const steps = deploySteps(view, stages);
  const share = typicalMs && clock && view.word === "Deploying" ? Math.min(0.97, clock.workingMs / typicalMs) : null;
  const full = variant === "full";

  const startNext = onStartNext && view.startNext && (
    <Button size="xs" variant="outline" disabled={moving} onClick={() => setConfirm(true)}>
      Start next
    </Button>
  );
  const confirmStartNext = onStartNext && (
    <ConfirmDeleteDialog
      open={confirm}
      onOpenChange={setConfirm}
      title="Start next"
      description="Move this deploy to the front of the line?"
      confirmLabel="Start next"
      loadingLabel="Moving..."
      variant="default"
      loading={moving}
      onConfirm={async () => {
        setMoving(true);
        const since = wait.current?.since ?? null;
        const moved = await onStartNext().finally(() => setMoving(false));
        if (moved) {
          setMovedSince(since);
          setConfirm(false);
        }
      }}
    />
  );

  const strip = (
    <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" aria-label="Phases">
      {steps.map(({ key, label, state }, i) => {
        const named = full || state === "now" || state === "held" || state === "failed";
        return (
          <li
            key={key}
            aria-current={state === "now" ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground/60",
              i > 0 && "before:mr-0.5 before:w-3.5 before:border-t before:border-border",
              state === "done" && "text-muted-foreground",
              state === "now" && "font-semibold text-status-info",
              state === "held" && (view.tone === "warn" ? "font-semibold text-status-warning" : "font-semibold text-foreground"),
              state === "failed" && "font-semibold text-status-error",
            )}
          >
            <StepMark state={state} warn={view.tone === "warn"} />
            <span className={named ? undefined : "sr-only"} title={state === "held" ? view.why : undefined}>
              {label}
            </span>
            <span className="sr-only">{SPOKEN[state]}</span>
          </li>
        );
      })}
    </ol>
  );

  const bar = share !== null && (
    <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-accent">
      <i
        className={cn(
          "block h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
          view.held ? "bg-muted-foreground/40" : "bg-status-info",
        )}
        style={{ width: `${(share * 100).toFixed(1)}%` }}
      />
    </div>
  );

  if (!full) {
    return (
      <div className="grid gap-2">
        {strip}
        {bar}
        {text && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[13px] tabular-nums" title={view.why}>
              {text.line}
            </span>
            {startNext}
          </div>
        )}
        {href && (
          <Link href={href} className={cn(quietLinkClass, "w-fit text-[13px]")}>
            Open →
          </Link>
        )}
        {confirmStartNext}
      </div>
    );
  }

  const hasLog = !!log?.length;
  return (
    <Card variant="surface" className="grid gap-3 p-4">
      <span className="sr-only" aria-live="assertive" aria-atomic="true">
        {announcement(view, steps, stages)}
      </span>
      <div className="flex items-start justify-between gap-4">
        {strip}
        {hasLog && onToggleExpand && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide deploy log" : "Show deploy log"}
            onClick={onToggleExpand}
            className="shrink-0 rounded p-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-brass"
          >
            <DisclosureChevron open={expanded} />
          </button>
        )}
      </div>
      {bar}
      {text && (
        <div className="grid gap-0.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm tabular-nums" title={view.why}>
              {text.line}
            </span>
            {startNext}
          </div>
          {text.meta && <span className="text-[13px] text-muted-foreground tabular-nums">{text.meta}</span>}
        </div>
      )}
      {cancelling && <p className="text-xs text-muted-foreground">Cancelling — the deploy will stop after the current phase.</p>}
      {expanded && hasLog && (
        <TerminalOutput
          lines={log!.map((line) => ({ text: line, html: highlightLogLine(line), level: detectLogLevel(line) }))}
          height="max-h-80"
          showFilters={false}
        />
      )}
      {confirmStartNext}
    </Card>
  );
}
