"use client";

import { useState } from "react";
import {
  Loader2,
  Rocket,
  ChevronDown,
  RotateCcw,
  History,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { DeploymentLog } from "@/components/log-viewer";
import { DeploymentStatusBadge, formatDuration } from "@/components/app-status";
import { Uptime } from "./timer";
import { InProgressDeployCard } from "./in-progress-deploy-card";

import type { Deployment } from "./types";

export function AppDeployPanel({
  filteredDeployments,
  deploying,
  serverRunningDeploy,
  deployStages,
  deployLog,
  deployStartTime,
  expandedDeployLog,
  setExpandedDeployLog,
  deployAbort,
  appStatus,
  gitUrl,
  source,
  autoDeploy,
  orgId,
  appId,
  viewingLogId,
  setViewingLogId,
  handleRollbackPreview,
  rollbackTarget,
  setRollbackTarget,
  rollbackPreview,
  setRollbackPreview,
  rollbackIncludeEnv,
  setRollbackIncludeEnv,
  rollbackLoading,
  handleRollbackConfirm,
}: {
  filteredDeployments: Deployment[];
  deploying: boolean;
  serverRunningDeploy: Deployment | null | undefined;
  deployStages: Record<string, "running" | "success" | "failed" | "skipped">;
  deployLog: string[];
  deployStartTime: number | null;
  expandedDeployLog: boolean;
  setExpandedDeployLog: (v: boolean) => void;
  deployAbort: AbortController | null;
  appStatus: string;
  gitUrl: string | null;
  source: string;
  autoDeploy: boolean | null;
  orgId: string;
  appId: string;
  viewingLogId: string | null;
  setViewingLogId: (id: string | null) => void;
  handleRollbackPreview: (deploymentId: string) => void;
  rollbackTarget: string | null;
  setRollbackTarget: (id: string | null) => void;
  rollbackPreview: {
    deploymentId: string;
    gitSha: string | null;
    gitMessage: string | null;
    deployedAt: string;
    hasEnvSnapshot: boolean;
    hasConfigSnapshot: boolean;
    configChanges: { field: string; from: string | null; to: string | null }[];
    envKeyChanges: { added: string[]; removed: string[]; changed: string[] } | null;
  } | null;
  setRollbackPreview: (v: null) => void;
  rollbackIncludeEnv: boolean;
  setRollbackIncludeEnv: (v: boolean) => void;
  rollbackLoading: boolean;
  handleRollbackConfirm: () => void;
}) {
  return (
    <>
      <div className="pt-4 space-y-4">
        {filteredDeployments.length === 0 && !deploying && !serverRunningDeploy ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
            <Rocket className="size-8 text-muted-foreground/50" />
            <div className="text-center space-y-1">
              <p className="text-sm font-medium">Ready for your first deploy</p>
              <p className="text-sm text-muted-foreground">
                {source === "git" && autoDeploy
                  ? "Push to your connected repo to trigger an automatic deploy, or deploy manually."
                  : "Hit the Deploy button above to get started."}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* In-progress deployment (client-side SSE stream) */}
            {deploying && (
              <InProgressDeployCard
                stages={deployStages}
                log={deployLog}
                startTime={deployStartTime}
                expanded={expandedDeployLog}
                onToggleExpand={() => setExpandedDeployLog(!expandedDeployLog)}
                onAbort={() => deployAbort?.abort()}
                canAbort
              />
            )}
            {/* In-progress deployment detected from server data (e.g. arrived mid-deploy) */}
            {!deploying && serverRunningDeploy && (
              <InProgressDeployCard
                stages={{}}
                log={[]}
                startTime={new Date(serverRunningDeploy.startedAt).getTime()}
                expanded={false}
                onToggleExpand={() => {}}
                trigger={serverRunningDeploy.trigger}
              />
            )}

            {filteredDeployments
              .filter((d) => d.status !== "queued" && d.status !== "running")
              .map((deployment, idx) => {
              const isActive = deployment.status === "success" && appStatus === "active" && idx === 0;
              const isStopped = deployment.status === "success" && appStatus === "stopped" && idx === 0;
              const isErrored = deployment.status === "success" && appStatus === "error" && idx === 0;
              const bgColor = isActive
                ? "bg-status-success-muted"
                : isStopped
                ? "bg-status-neutral-muted"
                : isErrored
                ? "bg-status-error-muted"
                : {
                    success: "bg-card",
                    failed: "bg-status-error-muted",
                    running: "bg-status-info-muted",
                    queued: "bg-status-neutral-muted",
                    cancelled: "bg-status-neutral-muted",
                    rolled_back: "bg-status-warning-muted",
                  }[deployment.status] || "bg-card";

              return (
              <div key={deployment.id} className={`squircle rounded-lg border ${bgColor} overflow-hidden`}>
                <button
                  type="button"
                  onClick={() => setViewingLogId(viewingLogId === deployment.id ? null : deployment.id)}
                  className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {isActive ? (
                      <Badge className="border-transparent bg-status-success text-white shrink-0">
                        <span className="mr-1.5 size-1.5 rounded-full bg-white animate-pulse" />
                        Live
                      </Badge>
                    ) : isStopped ? (
                      <Badge className="border-transparent bg-status-neutral-muted text-status-neutral shrink-0">
                        Stopped
                      </Badge>
                    ) : isErrored ? (
                      <Badge className="border-transparent bg-status-error-muted text-status-error shrink-0">
                        Crashed
                      </Badge>
                    ) : deployment.status === "success" && idx > 0 && appStatus === "active" ? (
                      <Badge className="border-transparent bg-status-neutral-muted text-status-neutral shrink-0">
                        Superseded
                      </Badge>
                    ) : (
                      <DeploymentStatusBadge status={deployment.status} />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">
                          {deployment.gitMessage || (
                            isActive ? (
                              <>
                                <span className="capitalize">{deployment.trigger}</span>
                                <span className="text-muted-foreground font-normal"> deploy</span>
                              </>
                            ) : (
                              <span className="capitalize">{deployment.trigger}</span>
                            )
                          )}
                        </p>
                        {deployment.gitSha && (() => {
                          const commitUrl = gitUrl?.replace(/\.git$/, "");
                          const sha7 = deployment.gitSha.slice(0, 7);
                          return commitUrl ? (
                            <a
                              href={`${commitUrl}/commit/${deployment.gitSha}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0 hover:bg-accent transition-colors"
                            >
                              {sha7}
                            </a>
                          ) : (
                            <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">
                              {sha7}
                            </code>
                          );
                        })()}
                      </div>
                      <p className="text-xs text-foreground/60 mt-0.5">
                        {(() => {
                          const triggerLabel = {
                            manual: "Manual deploy",
                            webhook: "Auto deploy",
                            api: "API deploy",
                            rollback: "Rollback",
                          }[deployment.trigger];
                          const by = deployment.triggeredByUser?.name;
                          return by ? `${triggerLabel} by ${by}` : triggerLabel;
                        })()}
                      </p>
                      {(deployment.status === "failed" || isErrored) && deployment.log && (() => {
                        // Extract the last ERROR line from the deploy log
                        const lines = deployment.log.split("\n");
                        const errorLine = [...lines].reverse().find(
                          (l) => l.includes("ERROR") || l.includes("FATAL") || l.includes("failed") || l.includes("crashed")
                        );
                        if (!errorLine) return null;
                        const cleaned = errorLine
                          .replace(/^\[.*?\]\s*/, "")
                          .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
                          .replace(/ghs_[A-Za-z0-9]+/g, "***")
                          .trim();
                        return (
                          <p className="text-xs text-status-error mt-1 truncate max-w-md" title={cleaned}>
                            {cleaned}
                          </p>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-foreground/50 shrink-0">
                    {isActive && deployment.finishedAt && (
                      <span className="text-status-success">
                        <Uptime since={deployment.finishedAt} />
                      </span>
                    )}
                    {deployment.durationMs != null && (
                      <span>built in {formatDuration(deployment.durationMs)}</span>
                    )}
                    <span>
                      {new Date(deployment.startedAt).toLocaleDateString()}
                    </span>
                    {/* Restore button — only on past successful deploys, not the active one */}
                    {deployment.status === "success" && !isActive && !deploying && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRollbackPreview(deployment.id);
                        }}
                      >
                        <History className="size-3" />
                        Restore
                      </Button>
                    )}
                    <ChevronDown className={`size-4 transition-transform ${viewingLogId === deployment.id ? "rotate-180" : ""}`} />
                  </div>
                </button>
                {viewingLogId === deployment.id && deployment.log && (
                  <DeploymentLog log={deployment.log} />
                )}
                {viewingLogId === deployment.id && !deployment.log && (
                  <div className="border-t p-4">
                    <p className="text-xs text-muted-foreground">No log output for this deployment.</p>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Rollback Confirmation Dialog */}
      <BottomSheet open={!!rollbackTarget} onOpenChange={(open) => { if (!open) { setRollbackTarget(null); setRollbackPreview(null); } }}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Restore deployment</BottomSheetTitle>
            <BottomSheetDescription>
              Roll back to a previous deployment. This will trigger a new deploy using the snapshot from that point in time.
            </BottomSheetDescription>
          </BottomSheetHeader>
          <div className="px-6 py-4 space-y-4">
            {rollbackLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading rollback preview...
              </div>
            )}
            {rollbackPreview && (
              <>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Rolling back to:</p>
                  <div className="squircle rounded-lg border bg-muted/50 p-3 space-y-1">
                    <p className="text-sm">{rollbackPreview.gitMessage || "Manual deploy"}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {rollbackPreview.gitSha && (
                        <code className="font-mono bg-muted px-1.5 py-0.5 rounded">
                          {rollbackPreview.gitSha.slice(0, 7)}
                        </code>
                      )}
                      <span>{new Date(rollbackPreview.deployedAt).toLocaleString()}</span>
                    </div>
                  </div>
                </div>

                {/* Config changes diff */}
                {rollbackPreview.configChanges.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Config changes</p>
                    <div className="squircle rounded-lg border divide-y text-xs">
                      {rollbackPreview.configChanges.map((change) => (
                        <div key={change.field} className="flex items-center justify-between px-3 py-2">
                          <span className="text-muted-foreground">{change.field}</span>
                          <div className="flex items-center gap-2">
                            <span className="line-through text-status-error">{change.from || "(none)"}</span>
                            <span>-&gt;</span>
                            <span className="text-status-success">{change.to || "(none)"}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {rollbackPreview.configChanges.length === 0 && rollbackPreview.hasConfigSnapshot && (
                  <p className="text-xs text-muted-foreground">No config changes detected.</p>
                )}

                {/* Env var changes */}
                {rollbackPreview.hasEnvSnapshot && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Switch
                        id="rollback-env"
                        checked={rollbackIncludeEnv}
                        onCheckedChange={setRollbackIncludeEnv}
                      />
                      <Label htmlFor="rollback-env" className="text-sm">
                        Include environment variable rollback
                      </Label>
                    </div>
                    {rollbackIncludeEnv && rollbackPreview.envKeyChanges && (
                      <div className="squircle rounded-lg border bg-muted/50 p-3 space-y-2 text-xs">
                        {rollbackPreview.envKeyChanges.added.length > 0 && (
                          <div>
                            <span className="text-status-success font-medium">Added: </span>
                            {rollbackPreview.envKeyChanges.added.join(", ")}
                          </div>
                        )}
                        {rollbackPreview.envKeyChanges.removed.length > 0 && (
                          <div>
                            <span className="text-status-error font-medium">Removed: </span>
                            {rollbackPreview.envKeyChanges.removed.join(", ")}
                          </div>
                        )}
                        {rollbackPreview.envKeyChanges.changed.length > 0 && (
                          <div>
                            <span className="text-amber-500 font-medium">Changed: </span>
                            {rollbackPreview.envKeyChanges.changed.join(", ")}
                          </div>
                        )}
                        {rollbackPreview.envKeyChanges.added.length === 0 &&
                          rollbackPreview.envKeyChanges.removed.length === 0 &&
                          rollbackPreview.envKeyChanges.changed.length === 0 && (
                          <span className="text-muted-foreground">No env var changes detected.</span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {!rollbackPreview.hasEnvSnapshot && (
                  <p className="text-xs text-muted-foreground">
                    No environment variable snapshot available for this deployment.
                  </p>
                )}
              </>
            )}
          </div>
          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => { setRollbackTarget(null); setRollbackPreview(null); }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRollbackConfirm}
              disabled={!rollbackPreview || rollbackLoading}
              className="squircle"
            >
              <RotateCcw className="size-4 mr-2" />
              Restore this deployment
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </>
  );
}
