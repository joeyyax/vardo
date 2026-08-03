"use client";

import { Loader2, Check, X, ChevronDown, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import { formatDuration } from "@/components/app-status";
import { Timer } from "./timer";
import {
  DEPLOY_STAGE_KEYS,
  ROLLBACK_STAGE_KEYS,
  STAGE_LABELS,
} from "@/lib/ui/deploy-stage";
import type { StageTiming } from "./hooks/use-deploy";

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
  typicalDurationMs,
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
  /** Duration of this app's last successful deploy, for comparison. */
  typicalDurationMs?: number | null;
}) {
  // Build a screen-reader announcement for the current deploy state
  const hasStages = Object.keys(stages).length > 0;
  // The phases in the stream name the run: only a rollback reports rollback phases.
  const isRollback = ROLLBACK_STAGE_KEYS.some((s) => stages[s]);
  const stageKeys = isRollback ? ROLLBACK_STAGE_KEYS : DEPLOY_STAGE_KEYS;
  const noun = isRollback ? "Rollback" : "Deployment";
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
    <div className="squircle rounded-lg border bg-status-info-muted overflow-hidden">
      <span className="sr-only" aria-live="assertive" aria-atomic="true">{liveAnnouncement}</span>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggleExpand(); }}
        className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Badge variant="outline" className="animate-pulse shrink-0">
            <Loader2 className="mr-1 size-3 animate-spin" />
            {cancelling ? "Cancelling" : isRollback ? "Rolling back" : "Deploying"}
          </Badge>
          <div className="flex items-center gap-1.5 flex-wrap">
            {stageKeys.map((s, i) => {
              const status = stages[s];
              const timing = stageTimes?.[s];
              return (
                <div key={s} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground/30 text-xs">›</span>}
                  {!status && <span className="size-1.5 rounded-full bg-muted-foreground/30" />}
                  {status === "running" && <Loader2 className="size-3 animate-spin text-status-info" />}
                  {status === "success" && <Check className="size-3 text-status-success" />}
                  {status === "failed" && <X className="size-3 text-status-error" />}
                  {status === "skipped" && <Minus className="size-3 text-muted-foreground/60" />}
                  <span className={`text-xs transition-colors duration-300 ${
                    status === "running" ? "text-status-info" :
                    status === "success" ? "text-status-success" :
                    status === "failed" ? "text-status-error" :
                    status === "skipped" ? "text-muted-foreground/60 line-through" :
                    "text-muted-foreground/40"
                  }`}>
                    {STAGE_LABELS[s]}
                  </span>
                  {timing && status !== "skipped" && (
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {timing.endedAt
                        ? formatDuration(timing.endedAt - timing.startedAt)
                        : <Timer since={timing.startedAt} />}
                    </span>
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
            <span className="text-xs text-foreground/50">
              <Timer since={startTime} />
              {typicalDurationMs ? ` / usually ${formatDuration(typicalDurationMs)}` : ""}
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
