"use client";

import { Loader2, Check, X, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import { Timer } from "./timer";

export function InProgressDeployCard({
  stages,
  log,
  startTime,
  expanded,
  onToggleExpand,
  onAbort,
  canAbort,
  trigger,
}: {
  stages: Record<string, "running" | "success" | "failed" | "skipped">;
  log: string[];
  startTime: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onAbort?: () => void;
  canAbort?: boolean;
  trigger?: string;
}) {
  const stageLabels: Record<string, string> = {
    clone: "Clone", build: "Build", deploy: "Deploy",
    healthcheck: "Health", routing: "Route", cleanup: "Cleanup",
  };
  const stageKeys = ["clone", "build", "deploy", "healthcheck", "routing", "cleanup"] as const;
  const hasStages = Object.keys(stages).length > 0;

  // Build a screen-reader announcement for the current deploy state
  const runningStage = stageKeys.find((s) => stages[s] === "running");
  const anyFailed = stageKeys.some((s) => stages[s] === "failed");
  const allDone = hasStages && stageKeys.filter((s) => stages[s]).every((s) => stages[s] === "success" || stages[s] === "skipped");
  // Only announce once a stage has actually transitioned — empty string on
  // initial mount so the assertive live region doesn't interrupt immediately.
  const liveAnnouncement = anyFailed
    ? `Deployment failed at ${stageLabels[stageKeys.find((s) => stages[s] === "failed")!] ?? "unknown"} stage`
    : allDone
      ? "Deployment completed successfully"
      : runningStage
        ? `Deploying: ${stageLabels[runningStage]} in progress`
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
            Deploying
          </Badge>
          {hasStages ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              {stageKeys.map((s, i) => {
                const status = stages[s];
                if (!status) return null;
                return (
                  <div key={s} className="flex items-center gap-1">
                    {i > 0 && status && <span className="text-muted-foreground/30 text-xs">›</span>}
                    {status === "running" && <Loader2 className="size-3 animate-spin text-status-info" />}
                    {status === "success" && <Check className="size-3 text-status-success" />}
                    {status === "failed" && <X className="size-3 text-status-error" />}
                    {status === "skipped" && <span className="text-muted-foreground text-xs">-</span>}
                    <span className={`text-xs ${
                      status === "running" ? "text-status-info" :
                      status === "success" ? "text-status-success" :
                      status === "failed" ? "text-status-error" :
                      "text-muted-foreground"
                    }`}>
                      {stageLabels[s]}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : trigger && (
            <span className="text-xs text-foreground/60 capitalize">{trigger} deploy in progress...</span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {startTime && (
            <Timer since={startTime} className="text-xs text-foreground/50" />
          )}
          {canAbort && onAbort && (
            <Button
              size="sm"
              variant="destructive"
              onClick={(e) => { e.stopPropagation(); onAbort(); }}
            >
              <X className="mr-1 size-3" />
              Abort
            </Button>
          )}
          {log.length > 0 && (
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
          )}
        </div>
      </div>
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
