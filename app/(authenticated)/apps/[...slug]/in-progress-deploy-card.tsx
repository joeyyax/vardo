"use client";

import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { Check, Loader2, X } from "lucide-react";
import { StatusMark } from "@/components/ui/status-dot";
import { TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import { useNow } from "@/components/deploy-progress";
import { Timer } from "./timer";
import {
  DEPLOY_STAGE_KEYS,
  ROLLBACK_STAGE_KEYS,
  STAGE_LABELS,
} from "@/lib/ui/deploy-stage";
import { deployCardText, deployClockOf, deployView, NO_WAIT, queuedStep, type WaitState } from "@/lib/ui/deploy-wait";
import type { StageTiming } from "./hooks/use-deploy";
import { Card } from "@/components/ui/card";

/** Spoken status for each step, since the row states it in color and shape. */
const STAGE_STATUS_WORDS: Record<string, string> = {
  running: "in progress",
  success: "done",
  failed: "failed",
  skipped: "skipped",
  pending: "pending",
  held: "queued",
};

export function InProgressDeployCard({
  stages,
  stageTimes,
  log,
  startTime,
  expanded,
  onToggleExpand,
  cancelling,
  trigger,
  typicalElapsedMs,
  queued,
  preparing = false,
  wait = NO_WAIT,
}: {
  stages: Record<string, "running" | "success" | "failed" | "skipped">;
  stageTimes?: Record<string, StageTiming>;
  log: string[];
  startTime: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
  /** A cancel was signaled; the engine is finishing its current phase. */
  cancelling?: boolean;
  trigger?: string;
  /** Run time of this app's last successful deploy, for comparison. */
  typicalElapsedMs?: number | null;
  /** Waiting for an executor to claim it; `startTime` is when it queued. */
  queued?: boolean;
  /** Created but not released to the queue yet. */
  preparing?: boolean;
  /** Waits from the deploy stream. */
  wait?: WaitState;
}) {
  const now = useNow(1000);
  const hasStages = Object.keys(stages).length > 0;
  const clock = startTime && now !== null ? deployClockOf({ wait, stages }, { startedAt: startTime, status: queued ? "queued" : undefined, now }) : null;
  const view = deployView({ queued: !!queued && !hasStages, preparing, wait: clock?.wait ?? null, started: hasStages, now });
  const text = clock ? deployCardText(view, clock, typicalElapsedMs ?? null) : null;
  // The phases in the stream name the run: only a rollback reports rollback phases.
  const isRollback = ROLLBACK_STAGE_KEYS.some((s) => stages[s]);
  const stageKeys = isRollback ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS;
  const first = queuedStep(view);
  const noun = isRollback ? "Rollback" : "Deployment";
  const runningStage = stageKeys.find((s) => stages[s] === "running");
  const failedStage = stageKeys.find((s) => stages[s] === "failed");
  const allDone = hasStages && stageKeys.filter((s) => stages[s]).every((s) => stages[s] === "success" || stages[s] === "skipped");
  // Empty until a stage transitions so the assertive live region doesn't fire on mount.
  const liveAnnouncement = failedStage
    ? `${noun} failed at ${STAGE_LABELS[failedStage]} stage`
    : allDone
      ? `${noun} completed successfully`
      : view.tone !== "info"
        ? view.label
        : runningStage
          ? `${isRollback ? "Rolling back" : "Deploying"}: ${STAGE_LABELS[runningStage]} in progress`
          : "";
  const steps: { key: string; label: string; status?: string }[] = [
    ...(isRollback ? [] : [{ key: "queued", label: first.label, status: first.state === "done" ? "success" : first.state === "now" ? "running" : "held" }]),
    ...stageKeys.map((s) => ({ key: s, label: STAGE_LABELS[s], status: stages[s] === "running" && view.held === s ? "held" : stages[s] })),
  ];

  return (
    <Card variant="surface" className={`${view.tone === "info" ? "bg-status-info-muted" : "bg-status-neutral-muted"} overflow-hidden`}>
      <span className="sr-only" aria-live="assertive" aria-atomic="true">{liveAnnouncement}</span>
      {/* The row is a mouse target; the chevron button is the control. */}
      <div
        onClick={onToggleExpand}
        className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          {/* Only the phase in flight carries color. */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {steps.map(({ key, label, status }, i) => {
              const timing = stageTimes?.[key];
              const running = status === "running";
              const held = status === "held";
              const failed = status === "failed";
              return (
                <div key={key} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground/25 text-xs">·</span>}
                  {running && <Loader2 className="size-3 animate-spin text-status-info" />}
                  {failed && <X className="size-3 text-status-error" />}
                  {status === "success" && <Check className="size-3 text-status-success" />}
                  {held && <StatusMark tone={view.tone === "warn" ? "warn" : "neutral"} pending />}
                  <span
                    title={held ? view.why : undefined}
                    className={`text-xs transition-colors duration-300 ${
                      failed ? "text-status-error font-medium" :
                      running ? "text-status-info font-medium" :
                      held ? "text-foreground font-medium" :
                      status === "skipped" ? "text-muted-foreground/50 line-through" :
                      status ? "text-muted-foreground" :
                      "text-muted-foreground/40"
                    }`}
                  >
                    {label}
                  </span>
                  <span className="sr-only">{STAGE_STATUS_WORDS[status ?? "pending"]}</span>
                  {running && timing && (
                    <Timer since={timing.startedAt} className="text-xs text-status-info/70" />
                  )}
                </div>
              );
            })}
          </div>
          {!hasStages && trigger && view.word === "Deploying" && (
            <span className="text-xs text-foreground/60 capitalize">{trigger} deploy in progress...</span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {text && (
            <span className="text-xs tabular-nums" title={view.why}>
              <span className="text-foreground/70">{text.line}</span>
              {text.meta && <span className="text-foreground/50"> · {text.meta}</span>}
            </span>
          )}
          {log.length > 0 && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? "Hide deploy log" : "Show deploy log"}
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              className="rounded p-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-brass"
            >
              <DisclosureChevron open={expanded} />
            </button>
          )}
        </div>
      </div>
      {cancelling && (
        <p className="px-4 pb-3 -mt-1 text-xs text-muted-foreground">
          Cancelling — the deploy will stop after the current phase.
        </p>
      )}
      {expanded && log.length > 0 && (
        <div className="px-4 pb-4">
          <TerminalOutput
            lines={log.map((text) => ({ text, html: highlightLogLine(text), level: detectLogLevel(text) }))}
            height="max-h-80"
            showFilters={false}
          />
        </div>
      )}
    </Card>
  );
}
