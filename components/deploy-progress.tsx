"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { DEPLOY_STAGE_KEYS, ROLLBACK_STAGE_KEYS, SHARED_STAGE_LABELS, STAGE_LABELS, sharedStage, stageHead } from "@/lib/ui/deploy-stage";
import {
  applyWait,
  deployCardText,
  lineLabel,
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
import { Term } from "@/components/term";
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
  const steps = keys.map((k, i): StripStep => {
    const state: StripStep["state"] =
      stages[k] === "success"
        ? "done"
        : i === current
          ? stages[k] === "failed"
            ? "failed"
            : view.held === k
              ? "held"
              : "now"
          : "todo";
    return { key: k, label: state === "held" && k === "build" ? SHARED_STAGE_LABELS.wait : STAGE_LABELS[k], state };
  });
  return [
    ...(rollback ? [] : [{ key: "queued", label: first.label, state: first.state }]),
    ...mergePrepare(steps),
  ];
}

/** Clone and compose as one Prepare step: done once both are, otherwise the state of the one in flight. */
function mergePrepare(steps: StripStep[]): StripStep[] {
  const prep = steps.filter((s) => s.key === "clone" || s.key === "compose");
  if (prep.length < 2) return steps.map((s) => (s.key === "clone" || s.key === "compose" ? { ...s, key: "prepare" } : s));
  const live = prep.find((s) => s.state !== "done" && s.state !== "todo");
  const state = live?.state ?? (prep.every((s) => s.state === "done") ? "done" : prep[0].state === "done" ? "now" : "todo");
  const merged: StripStep = { key: "prepare", label: SHARED_STAGE_LABELS.prepare, state };
  return [merged, ...steps.filter((s) => s.key !== "clone" && s.key !== "compose")];
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
        state === "todo" && "shadow-[inset_0_0_0_1.5px_currentColor]",
        state === "now" && "shadow-[inset_0_0_0_2px_currentColor] motion-safe:animate-pulse",
        state === "held" && cn("shadow-[inset_0_0_0_2px_currentColor]", warn && "text-status-warning"),
      )}
    />
  );
}

/** What a screen reader hears as the run moves: state changes only, never the countdown. */
function announcement(view: DeployView, wait: WaitState, steps: StripStep[], stages: Record<string, string>): string {
  const rollback = ROLLBACK_STAGE_KEYS.some((k) => stages[k]);
  const noun = rollback ? "Rollback" : "Deployment";
  const failed = steps.find((s) => s.state === "failed");
  if (failed) return `${noun} failed at ${failed.label} stage`;
  const phases = steps.filter((s) => s.key !== "queued");
  if (Object.keys(stages).length > 0 && phases.every((s) => s.state === "done")) return `${noun} completed successfully`;
  if (view.held && wait.current?.ahead != null) return lineLabel(view.held === "build" ? "build" : "deploy", { ahead: wait.current.ahead }, null);
  if (view.held && view.why) return view.line ?? view.word;
  if (view.tone !== "info") return view.word;
  const now = steps.find((s) => s.state === "now" && s.key !== "queued");
  if (!now) return "";
  return rollback ? `Rolling back: ${now.label} in progress` : stageHead(sharedStage(now.key === "prepare" ? "clone" : now.key) ?? "prepare");
}

/** What Start next does: "It starts before the 2 deploys ahead of it." */
export function startNextConsequence(ahead: number): string {
  return ahead === 1 ? "It starts before the deploy ahead of it." : `It starts before the ${ahead} deploys ahead of it.`;
}

/** The card's line, with why a plain Queued waits on hover, focus or tap. */
function WaitLine({ view, line, className }: { view: DeployView; line: string; className: string }) {
  if (!view.why) return <span className={className}>{line}</span>;
  return (
    <Term note={view.why} className={className}>
      {line}
    </Term>
  );
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
  subject,
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
  /** Compact: the app, so each "Open" link names its deploy to a screen reader. */
  subject?: string;
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
  const lineRef = useRef<HTMLDivElement>(null);
  const startNextRef = useRef<HTMLButtonElement>(null);
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
    <Button ref={startNextRef} size="xs" variant="outline" className="pointer-coarse:h-11" disabled={moving} onClick={() => setConfirm(true)}>
      Start next
    </Button>
  );
  const confirmStartNext = onStartNext && (
    <ConfirmDeleteDialog
      open={confirm}
      onOpenChange={setConfirm}
      title="Start next"
      description={startNextConsequence(wait.current?.ahead ?? 0)}
      confirmLabel="Start next"
      loadingLabel="Moving..."
      variant="default"
      loading={moving}
      // Back to Start next, or to its line once the deploy is first and the button is gone.
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        (startNextRef.current?.isConnected ? startNextRef.current : lineRef.current)?.focus();
      }}
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

  // Every step leads with a connector; the clip hides the one that starts each line.
  const strip = (
    <div className="min-w-0 overflow-x-clip">
      <ol className="-ml-5.5 flex flex-wrap items-center gap-x-1.5 gap-y-1" aria-label="Phases">
        {steps.map(({ key, label, state }) => {
          const named = full || state === "now" || state === "held" || state === "failed";
          return (
            <li
              key={key}
              aria-current={state === "now" ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground",
                "before:mr-0.5 before:w-3.5 before:border-t before:border-border",
                  state === "now" && "font-semibold text-status-info",
                state === "held" && (view.tone === "warn" ? "font-semibold text-status-warning" : "font-semibold text-foreground"),
                state === "failed" && "font-semibold text-status-error",
              )}
            >
              <StepMark state={state} warn={view.tone === "warn"} />
              <span className={named ? undefined : "sr-only"}>
                {label}
              </span>
              <span className="sr-only">{SPOKEN[state]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );

  const bar = share !== null && (
    <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-accent">
      <i
        className={cn(
          "block h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
          view.held ? "bg-muted-foreground/70" : "bg-status-info",
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
          <div ref={lineRef} tabIndex={-1} className="flex flex-wrap items-center gap-x-3 gap-y-1 outline-none">
            <WaitLine view={view} line={text.line} className="text-[13px] tabular-nums" />
            {startNext}
          </div>
        )}
        {href && (
          <Link href={href} className={cn(quietLinkClass, "w-fit text-[13px]")}>
            Open →{subject && <span className="sr-only"> deploy of {subject}</span>}
          </Link>
        )}
        {confirmStartNext}
      </div>
    );
  }

  const hasLog = !!log?.length;
  return (
    <Card variant="surface" className="grid gap-3 p-4">
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement(view, wait, steps, stages)}
      </span>
      <div className="flex items-start justify-between gap-4">
        {strip}
        {hasLog && onToggleExpand && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide deploy log" : "Show deploy log"}
            onClick={onToggleExpand}
            className="relative shrink-0 rounded p-0.5 after:absolute after:-inset-3 hover:bg-accent focus-visible:outline-2 focus-visible:outline-brass pointer-fine:after:hidden"
          >
            <DisclosureChevron open={expanded} />
          </button>
        )}
      </div>
      {bar}
      {text && (
        <div className="grid gap-0.5">
          <div ref={lineRef} tabIndex={-1} className="flex flex-wrap items-center gap-x-3 gap-y-1 outline-none">
            <WaitLine view={view} line={text.line} className="text-sm tabular-nums" />
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
