"use client";

import { Loader2, X, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import { formatDuration } from "@/components/app-status";
import { Timer } from "./timer";
import {
  DEPLOY_STAGE_KEYS,
  ROLLBACK_STAGE_KEYS,
  STAGE_LABELS,
  stageProgress,
} from "@/lib/ui/deploy-stage";
import type { StageTiming } from "./hooks/use-deploy";

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
}: {
  stages: Record<string, "running" | "success" | "failed" | "skipped">;
  stageTimes?: Record<string, StageTiming>;
  log: string[];
  startTime: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onAbort?: () => void;
  canAbort?: boolean;
  /** A cancel has been signalled and the engine is finishing its current phase. */
  cancelling?: boolean;
  trigger?: string;
  /** End-to-end time of this app's last successful deploy, for comparison. */
  typicalElapsedMs?: number | null;
}) {
  // Build a screen-reader announcement for the current deploy state
  const hasStages = Object.keys(stages).length > 0;
  // The phases in the stream name the run: only a rollback reports rollback phases.
  const isRollback = ROLLBACK_STAGE_KEYS.some((s) => stages[s]);
  const stageKeys = isRollback ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS;
  const noun = isRollback ? "Rollback" : "Deployment";
  const progress = stageProgress(stages, stageKeys);
  const runningStage = stageKeys.find((s) => stages[s] === "running");
  const failedStage = stageKeys.find((s) => stages[s] === "failed");
  const allDone = hasStages && stageKeys.filter((s) => stages[s]).every((s) => stages[s] === "success" || stages[s] === "skipped");
  // Only announce once a stage has actually transitioned — empty string on
  // initial mount so the assertive live region doesn't interrupt immediately.
  const liveAnnouncement = failedStage
    ? `${noun} failed at ${STAGE_LABELS[failedStage]} stage`
    : allDone
      ? `${noun} completed successfully`
      : runningStage
        ? `${isRollback ? "Rolling back" : "Deploying"}: ${STAGE_LABELS[runningStage]} in progress`
        : "";

  return (
    <div className="squircle rounded-lg bg-status-info-muted shadow-card overflow-hidden dark:border">
      <span className="sr-only" aria-live="assertive" aria-atomic="true">{liveAnnouncement}</span>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggleExpand(); }}
        className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Badge variant="info" className="animate-pulse shrink-0">
            <Loader2 className="mr-1 size-3 animate-spin" />
            {cancelling ? "Cancelling" : isRollback ? "Rolling back" : "Deploying"}
          </Badge>
          {/* One axis of emphasis: only the phase in flight carries color, so
              finished work reads as context rather than as news. */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {stageKeys.map((s, i) => {
              const status = stages[s];
              const timing = stageTimes?.[s];
              const running = status === "running";
              const failed = status === "failed";
              return (
                <div key={s} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground/25 text-xs">·</span>}
                  {running && <Loader2 className="size-3 animate-spin text-status-info" />}
                  {failed && <X className="size-3 text-status-error" />}
                  <span className={`text-xs transition-colors duration-300 ${
                    failed ? "text-status-error font-medium" :
                    running ? "text-status-info font-medium" :
                    status === "skipped" ? "text-muted-foreground/50 line-through" :
                    status ? "text-muted-foreground" :
                    "text-muted-foreground/40"
                  }`}>
                    {STAGE_LABELS[s]}
                  </span>
                  {/* Shape and color are the only cues left on the row. */}
                  <span className="sr-only">{STAGE_STATUS_WORDS[status ?? "pending"]}</span>
                  {running && timing && (
                    <Timer since={timing.startedAt} className="text-[10px] text-status-info/70" />
                  )}
                </div>
              );
            })}
          </div>
          {!hasStages && trigger && (
            <span className="text-xs text-foreground/60 capitalize">{trigger} deploy in progress...</span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {startTime && (
            <span className="text-xs text-foreground/50 tabular-nums">
              {progress.position > 0 ? `${progress.position} of ${progress.total} · ` : ""}
              <Timer since={startTime} />
              {typicalElapsedMs ? ` / usually ${formatDuration(typicalElapsedMs)}` : ""}
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
              {cancelling ? "Cancelling..." : "Abort"}
            </Button>
          )}
          {log.length > 0 && (
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
          )}
        </div>
      </div>
      {cancelling && (
        <p className="px-4 pb-3 -mt-1 text-xs text-muted-foreground">
          Cancelling — the deploy will stop after the current phase.
        </p>
      )}
      {expanded && log.length > 0 && (
        <div className="border-t">
          <TerminalOutput
            lines={log.map((text) => ({ text, html: highlightLogLine(text), level: detectLogLevel(text) }))}
            height="max-h-80"
            showFilters={false}
          />
        </div>
      )}
    </div>
  );
}
