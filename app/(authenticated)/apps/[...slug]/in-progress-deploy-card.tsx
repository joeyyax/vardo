"use client";

import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { Check, Loader2, X } from "lucide-react";
import { StatusMark } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import { formatDuration, formatUptime } from "@/lib/metrics/format";
import { useNow } from "@/components/deploy-progress";
import { Timer } from "./timer";
import {
  DEPLOY_STAGE_KEYS,
  ROLLBACK_STAGE_KEYS,
  STAGE_LABELS,
  stageProgress,
} from "@/lib/ui/deploy-stage";
import { deployClockOf, NO_WAIT, waitLabel, waitWord, type WaitState } from "@/lib/ui/deploy-wait";
import type { StageTiming } from "./hooks/use-deploy";
import { Card } from "@/components/ui/card";

/** Spoken status for each step, since the row states it in color and shape. */
const STAGE_STATUS_WORDS: Record<string, string> = {
  running: "in progress",
  success: "done",
  failed: "failed",
  skipped: "skipped",
  pending: "pending",
};

export function InProgressDeployCard({
  stages,
  stageTimes,
  log,
  startTime,
  expanded,
  onToggleExpand,
  onAbort,
  canAbort,
  cancelling,
  trigger,
  typicalElapsedMs,
  queued,
  wait = NO_WAIT,
}: {
  stages: Record<string, "running" | "success" | "failed" | "skipped">;
  stageTimes?: Record<string, StageTiming>;
  log: string[];
  startTime: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onAbort?: () => void;
  canAbort?: boolean;
  /** A cancel was signaled; the engine is finishing its current phase. */
  cancelling?: boolean;
  trigger?: string;
  /** Run time of this app's last successful deploy, for comparison. */
  typicalElapsedMs?: number | null;
  /** Waiting for an executor to claim it; `startTime` is when it queued. */
  queued?: boolean;
  /** Waits from the deploy stream. */
  wait?: WaitState;
}) {
  const now = useNow(1000);
  const clock = startTime && now !== null ? deployClockOf({ wait, stages }, { startedAt: startTime, status: queued ? "queued" : undefined, now }) : null;
  const held = clock?.wait ?? null;
  const hasStages = Object.keys(stages).length > 0;
  // The phases in the stream name the run: only a rollback reports rollback phases.
  const isRollback = ROLLBACK_STAGE_KEYS.some((s) => stages[s]);
  const stageKeys = isRollback ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS;
  const noun = isRollback ? "Rollback" : "Deployment";
  const progress = stageProgress(stages, stageKeys);
  const runningStage = stageKeys.find((s) => stages[s] === "running");
  const failedStage = stageKeys.find((s) => stages[s] === "failed");
  const allDone = hasStages && stageKeys.filter((s) => stages[s]).every((s) => stages[s] === "success" || stages[s] === "skipped");
  // Empty until a stage transitions so the assertive live region doesn't fire on mount.
  const liveAnnouncement = failedStage
    ? `${noun} failed at ${STAGE_LABELS[failedStage]} stage`
    : allDone
      ? `${noun} completed successfully`
      : held
        ? waitLabel(held)
        : runningStage
        ? `${isRollback ? "Rolling back" : "Deploying"}: ${STAGE_LABELS[runningStage]} in progress`
        : "";

  return (
    <Card variant="surface" className={`${held ? "bg-status-neutral-muted" : "bg-status-info-muted"} overflow-hidden`}>
      <span className="sr-only" aria-live="assertive" aria-atomic="true">{liveAnnouncement}</span>
      {/* The row is a mouse target; the chevron button is the control, so Abort isn't nested in one. */}
      <div
        onClick={onToggleExpand}
        className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          {held && !cancelling ? (
            <Badge variant="neutral" className="shrink-0">{waitWord(held.reason)}</Badge>
          ) : (
            <Badge variant="info" className="animate-pulse shrink-0">
              <Loader2 className="mr-1 size-3 animate-spin" />
              {cancelling ? "Cancelling" : isRollback ? "Rolling back" : "Deploying"}
            </Badge>
          )}
          {/* Only the phase in flight carries color. No phases run while queued. */}
          <div className={`items-center gap-1.5 flex-wrap ${queued ? "hidden" : "flex"}`}>
            {stageKeys.map((s, i) => {
              const status = stages[s];
              const timing = stageTimes?.[s];
              const running = status === "running" && !held;
              const waiting = status === "running" && !!held;
              const failed = status === "failed";
              return (
                <div key={s} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground/25 text-xs">·</span>}
                  {running && <Loader2 className="size-3 animate-spin text-status-info" />}
                  {failed && <X className="size-3 text-status-error" />}
                  {status === "success" && <Check className="size-3 text-status-success" />}
                  {waiting && <StatusMark tone="neutral" pending />}
                  <span className={`text-xs transition-colors duration-300 ${
                    failed ? "text-status-error font-medium" :
                    running ? "text-status-info font-medium" :
                    waiting ? "text-foreground font-medium" :
                    status === "skipped" ? "text-muted-foreground/50 line-through" :
                    status ? "text-muted-foreground" :
                    "text-muted-foreground/40"
                  }`}>
                    {STAGE_LABELS[s]}
                  </span>
                  <span className="sr-only">{waiting ? "waiting" : STAGE_STATUS_WORDS[status ?? "pending"]}</span>
                  {running && timing && (
                    <Timer since={timing.startedAt} className="text-xs text-status-info/70" />
                  )}
                </div>
              );
            })}
          </div>
          {!hasStages && trigger && !held && (
            <span className="text-xs text-foreground/60 capitalize">{trigger} deploy in progress...</span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {clock && (
            <span className="text-xs text-foreground/50 tabular-nums">
              {held ? (
                <>
                  <span className="text-foreground/70">{waitLabel(held)}</span>
                  {` · ${formatUptime(Math.min(now! - held.since, clock.waitedMs) / 1000)}`}
                </>
              ) : (
                <>
                  {progress.position > 0 ? `${progress.position} of ${progress.total} · ` : ""}
                  {formatUptime(clock.workingMs / 1000)}
                  {typicalElapsedMs ? ` / usually ${formatDuration(typicalElapsedMs)}` : ""}
                  {clock.waitedMs >= 1000 && ` · waited ${formatUptime(clock.waitedMs / 1000)}`}
                </>
              )}
            </span>
          )}
          {canAbort && onAbort && (
            <Button
              size="sm"
              variant="destructive"
              disabled={cancelling}
              onClick={(e) => { e.stopPropagation(); onAbort(); }}
            >
              <X className="mr-1 size-3" />
              {queued ? "Cancel" : cancelling ? "Cancelling..." : "Abort"}
            </Button>
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
