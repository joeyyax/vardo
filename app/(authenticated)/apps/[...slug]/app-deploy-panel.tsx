"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Rocket,
  ChevronDown,
  RotateCcw,
  X,
  Clock,
  Zap,
  Settings,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { toast } from "@/lib/messenger";
import { Uptime } from "./timer";
import { InProgressDeployCard } from "./in-progress-deploy-card";

import type { useDeploy } from "./hooks/use-deploy";
import type { Deployment, SlotStatus } from "./types";

export interface AppDeployPanelProps {
  orgId: string;
  appId: string;
  filteredDeployments: Deployment[];
  serverRunningDeploy: Deployment | null | undefined;
  appStatus: string;
  gitUrl: string | null;
  source: string;
  autoDeploy: boolean | null;
  deploy: ReturnType<typeof useDeploy>;
}

function triggerLabel(trigger: string): string {
  return {
    manual: "Manual deploy",
    webhook: "Auto deploy",
    api: "API deploy",
    rollback: "Rollback",
  }[trigger] ?? `${trigger.charAt(0).toUpperCase()}${trigger.slice(1)} deploy`;
}

function deployLabel(d: Deployment): string {
  return d.gitMessage || d.gitSha?.slice(0, 7) || triggerLabel(d.trigger);
}

function CommitSha({ sha, gitUrl }: { sha: string; gitUrl: string | null }) {
  const commitUrl = gitUrl?.replace(/\.git$/, "");
  const sha7 = sha.slice(0, 7);
  return commitUrl ? (
    <a
      href={`${commitUrl}/commit/${sha}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0 hover:bg-accent transition-colors"
      aria-label={`View commit ${sha7}`}
    >
      {sha7}
    </a>
  ) : (
    <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0" aria-label={`Commit ${sha7}`}>
      {sha7}
    </code>
  );
}

function SlotPill({ slot }: { slot: string | null }) {
  if (!slot) return null;
  const color = slot === "green" ? "bg-emerald-500/15 text-emerald-600" : "bg-blue-500/15 text-blue-600";
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color}`}>
      {slot}
    </span>
  );
}

export function AppDeployPanel({
  orgId,
  appId,
  filteredDeployments,
  serverRunningDeploy,
  appStatus,
  gitUrl,
  source,
  autoDeploy,
  deploy,
}: AppDeployPanelProps) {
  const {
    deploying,
    deployStages,
    deployLog,
    deployStartTime,
    expandedDeployLog,
    setExpandedDeployLog,
    deployAbort,
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
  } = deploy;

  const [expandedServerDeploy, setExpandedServerDeploy] = useState(false);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  const [abortingDeploy, setAbortingDeploy] = useState(false);
  const [showInfra, setShowInfra] = useState(false);
  const [slotStatus, setSlotStatus] = useState<SlotStatus | null>(null);
  const [instantRollingBack, setInstantRollingBack] = useState(false);
  const [confirmRollbackOpen, setConfirmRollbackOpen] = useState(false);
  const liveCardRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const prevDeploying = useRef(deploying);
  useEffect(() => {
    const wasDeploying = prevDeploying.current;
    prevDeploying.current = deploying;
    if (deploying) return;

    let cancelled = false;
    async function fetchSlotStatus() {
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/slot-status`);
        if (res.ok && !cancelled) {
          setSlotStatus(await res.json());
        }
      } catch { /* best-effort */ }
    }
    if (!wasDeploying || !deploying) fetchSlotStatus();
    return () => { cancelled = true; };
  }, [orgId, appId, deploying]);

  const handleInstantRollback = useCallback(async () => {
    setConfirmRollbackOpen(false);
    setInstantRollingBack(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/instant-rollback`,
        { method: "POST" },
      );
      const data = await res.json();
      if (res.ok) {
        toast.success(`Rolled back in ${formatDuration(data.durationMs)}`);
        router.refresh();
        requestAnimationFrame(() => liveCardRef.current?.focus());
      } else {
        toast.error(data.error || "Instant rollback failed");
      }
    } catch {
      toast.error("Instant rollback failed");
    } finally {
      setInstantRollingBack(false);
    }
  }, [orgId, appId, router]);

  const handleAbortDeploy = useCallback(async (deploymentId?: string) => {
    setAbortingDeploy(true);
    try {
      let targetId = deploymentId;
      if (!targetId) {
        const appRes = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}`);
        if (appRes.ok) {
          const { app: appData } = await appRes.json();
          const active = appData.deployments?.find(
            (d: { status: string }) => d.status === "running" || d.status === "queued"
          );
          targetId = active?.id;
        }
      }
      if (!targetId) {
        toast.error("No active deployment to cancel");
        return;
      }
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/deployments/${targetId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to cancel deployment");
        return;
      }
      deployAbort?.abort();
      toast.success("Deployment cancelled");
      router.refresh();
    } catch {
      toast.error("Failed to cancel deployment");
    } finally {
      setAbortingDeploy(false);
    }
  }, [orgId, appId, deployAbort, router]);

  const handleCancelQueued = useCallback(async (deploymentId: string) => {
    setCancellingIds((prev) => new Set(prev).add(deploymentId));
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/deployments/${deploymentId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to cancel deployment");
        return;
      }
      toast.success("Deployment cancelled");
      router.refresh();
    } catch {
      toast.error("Failed to cancel deployment");
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(deploymentId);
        return next;
      });
    }
  }, [orgId, appId, router]);

  const queuedDeployments = filteredDeployments
    .filter((d) => d.status === "queued" && d.id !== serverRunningDeploy?.id)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const completedDeployments = filteredDeployments
    .filter((d) => d.status !== "queued" && d.status !== "running");

  const liveDeploy = completedDeployments.find(
    (d) => d.status === "success" && (appStatus === "active" || appStatus === "stopped" || appStatus === "error")
  );

  const showRollbackAction = slotStatus?.standbyAvailable && appStatus === "active";

  const instantRollbackDeploy = showRollbackAction
    ? completedDeployments.find(
        (d) => d.id !== liveDeploy?.id && d.status === "success" && (
          d.id === slotStatus?.standbyDeploymentId ||
          (!slotStatus?.standbyDeploymentId && d !== liveDeploy)
        )
      )
    : null;

  const historyDeployments = completedDeployments.filter(
    (d) => d.id !== liveDeploy?.id && d.id !== instantRollbackDeploy?.id
  );

  function toggleLog(deploymentId: string) {
    setViewingLogId(viewingLogId === deploymentId ? null : deploymentId);
  }

  function renderDeploymentCard(
    deployment: Deployment,
    variant: "live" | "rollback" | "history",
  ) {
    const isLive = variant === "live" && appStatus === "active";
    const isStopped = variant === "live" && appStatus === "stopped";
    const isErrored = variant === "live" && appStatus === "error";

    const bgColor = variant === "live"
      ? isLive ? "bg-status-success-muted" : isStopped ? "bg-status-neutral-muted" : isErrored ? "bg-status-error-muted" : "bg-card"
      : variant === "rollback"
      ? "bg-amber-500/5 border-amber-500/20"
      : ({
          success: "bg-card",
          failed: "bg-status-error-muted",
          cancelled: "bg-status-neutral-muted",
          rolled_back: "bg-status-warning-muted",
          superseded: "bg-status-neutral-muted",
        } as Record<string, string>)[deployment.status] || "bg-card";

    const errorSnippet = (deployment.status === "failed" || isErrored) && deployment.log ? (() => {
      const lines = deployment.log!.split("\n");
      const errorLine = [...lines].reverse().find(
        (l) => l.includes("ERROR") || l.includes("FATAL") || l.includes("failed") || l.includes("crashed")
      );
      if (!errorLine) return null;
      return errorLine
        .replace(/^\[.*?\]\s*/, "")
        .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
        .replace(/ghs_[A-Za-z0-9]+/g, "***")
        .trim();
    })() : null;

    const isExpanded = viewingLogId === deployment.id;
    const logPanelId = `deploy-log-${deployment.id}`;
    const label = deployLabel(deployment);

    return (
      <div
        key={deployment.id}
        ref={variant === "live" ? liveCardRef : undefined}
        tabIndex={variant === "live" ? -1 : undefined}
        className={`squircle rounded-lg border ${bgColor} overflow-hidden`}
      >
        <div className="flex items-center justify-between gap-4 p-4 cursor-pointer hover:bg-accent/50 transition-colors"
          onClick={() => toggleLog(deployment.id)}
        >
          <div className="flex items-center gap-3 min-w-0">
            {variant === "live" ? (
              isLive ? (
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
              ) : (
                <DeploymentStatusBadge status={deployment.status} />
              )
            ) : variant === "rollback" ? (
              <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-500 shrink-0 gap-1">
                <Zap className="size-3" />
                Instant rollback
              </Badge>
            ) : deployment.status === "success" ? (
              <Badge className="border-transparent bg-status-neutral-muted text-status-neutral shrink-0">
                Superseded
              </Badge>
            ) : (
              <DeploymentStatusBadge status={deployment.status} />
            )}
            {showInfra && <SlotPill slot={deployment.slot} />}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">
                  {deployment.gitMessage || triggerLabel(deployment.trigger)}
                </p>
                {deployment.gitSha && <CommitSha sha={deployment.gitSha} gitUrl={gitUrl} />}
              </div>
              <p className="text-xs text-foreground/60 mt-0.5">
                {(() => {
                  const tl = triggerLabel(deployment.trigger);
                  const by = deployment.triggeredByUser?.name;
                  return by ? `${tl} by ${by}` : tl;
                })()}
              </p>
              {errorSnippet && (
                <p className="text-xs text-status-error mt-1 truncate max-w-md" title={errorSnippet}>
                  {errorSnippet}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-foreground/50 shrink-0">
            {variant === "live" && isLive && deployment.finishedAt && (
              <span className="text-status-success">
                <Uptime since={deployment.finishedAt} />
              </span>
            )}
            {deployment.durationMs != null && (
              <span>built in {formatDuration(deployment.durationMs)}</span>
            )}
            <span>{new Date(deployment.startedAt).toLocaleDateString()}</span>
            {variant === "rollback" && !deploying && (
              <div onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 px-3 text-xs gap-1.5 bg-amber-700 hover:bg-amber-800 text-white"
                  disabled={instantRollingBack}
                  aria-label={`Roll back to ${label}`}
                  onClick={() => setConfirmRollbackOpen(true)}
                >
                  {instantRollingBack ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Zap className="size-3" />
                  )}
                  Roll back
                </Button>
              </div>
            )}
            {variant === "history" && deployment.status === "success" && !deploying && (
              <div onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  aria-label={`Rebuild ${label}`}
                  onClick={() => handleRollbackPreview(deployment.id)}
                >
                  <RefreshCw className="size-3" />
                  Rebuild
                </Button>
              </div>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); toggleLog(deployment.id); }}
              aria-expanded={isExpanded}
              aria-controls={logPanelId}
              aria-label={`Toggle deploy log for ${label}`}
              className="p-0.5 rounded hover:bg-accent transition-colors"
            >
              <ChevronDown className={`size-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
            </button>
          </div>
        </div>
        {isExpanded && deployment.log && (
          <div id={logPanelId}>
            <DeploymentLog log={deployment.log} />
          </div>
        )}
        {isExpanded && !deployment.log && (
          <div id={logPanelId} className="border-t p-4">
            <p className="text-xs text-muted-foreground">No log output for this deployment.</p>
          </div>
        )}
      </div>
    );
  }

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
          <>
            {/* Infrastructure toggle */}
            {completedDeployments.length > 0 && (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 px-2 text-xs gap-1.5 ${showInfra ? "text-foreground" : "text-muted-foreground"}`}
                  onClick={() => setShowInfra(!showInfra)}
                  aria-pressed={showInfra}
                >
                  <Settings className="size-3" />
                  Deployment slots
                </Button>
              </div>
            )}

            <div className="space-y-2">
              {/* In-progress deploys */}
              {deploying && (
                <InProgressDeployCard
                  stages={deployStages}
                  log={deployLog}
                  startTime={deployStartTime}
                  expanded={expandedDeployLog}
                  onToggleExpand={() => setExpandedDeployLog(!expandedDeployLog)}
                  onAbort={() => handleAbortDeploy()}
                  canAbort={!abortingDeploy}
                />
              )}
              {!deploying && serverRunningDeploy && serverRunningDeploy.status === "running" && (
                <InProgressDeployCard
                  stages={{}}
                  log={serverRunningDeploy.log ? serverRunningDeploy.log.split("\n") : []}
                  startTime={new Date(serverRunningDeploy.startedAt).getTime()}
                  expanded={expandedServerDeploy}
                  onToggleExpand={() => setExpandedServerDeploy((prev) => !prev)}
                  onAbort={() => handleAbortDeploy(serverRunningDeploy.id)}
                  canAbort={!abortingDeploy}
                  trigger={serverRunningDeploy.trigger}
                />
              )}

              {/* Queued */}
              {queuedDeployments.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground px-1">Queued</h3>
                  {queuedDeployments.map((deployment, idx) => {
                    const position = idx + 1;
                    const total = queuedDeployments.length;
                    const isCancelling = cancellingIds.has(deployment.id);
                    const label = triggerLabel(deployment.trigger);
                    const by = deployment.triggeredByUser?.name;
                    return (
                      <div
                        key={deployment.id}
                        className="squircle rounded-lg border bg-status-neutral-muted overflow-hidden"
                      >
                        <div className="flex items-center justify-between gap-4 p-4">
                          <div className="flex items-center gap-3 min-w-0">
                            <Badge className="border-transparent bg-status-neutral-muted text-status-neutral shrink-0 gap-1.5">
                              <Clock className="size-3" />
                              Queued
                            </Badge>
                            <div className="min-w-0">
                              <p className="text-sm font-medium">
                                {deployment.gitMessage || label}
                              </p>
                              <p className="text-xs text-foreground/60 mt-0.5">
                                {by ? `${label} by ${by}` : label}
                                {" · "}
                                Position {position} of {total}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs gap-1 shrink-0"
                            disabled={isCancelling}
                            aria-label={`Cancel ${deployment.gitMessage || label}`}
                            onClick={() => handleCancelQueued(deployment.id)}
                          >
                            {isCancelling ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <X className="size-3" />
                            )}
                            Cancel
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Live */}
              {liveDeploy ? (
                renderDeploymentCard(liveDeploy, "live")
              ) : completedDeployments.length > 0 && !deploying && (
                <div className="squircle rounded-lg border border-dashed bg-muted/30 p-4">
                  <p className="text-sm text-muted-foreground text-center">No active deployment</p>
                </div>
              )}

              {/* Instant rollback */}
              {instantRollbackDeploy && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground px-1 flex items-center gap-1.5">
                    <Zap className="size-3" />
                    Standby
                  </h3>
                  {renderDeploymentCard(instantRollbackDeploy, "rollback")}
                </div>
              )}

              {/* History */}
              {historyDeployments.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground px-1">History</h3>
                  {historyDeployments.map((d) => renderDeploymentCard(d, "history"))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Instant rollback confirmation */}
      <AlertDialog open={confirmRollbackOpen} onOpenChange={setConfirmRollbackOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to previous version?</AlertDialogTitle>
            <AlertDialogDescription>
              This will swap live traffic to the previous deployment. The current deployment will become the standby.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleInstantRollback}
              className="bg-amber-700 hover:bg-amber-800 text-white"
            >
              <Zap className="size-4 mr-2" />
              Roll back now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rebuild preview bottom sheet (full rebuild path) */}
      <BottomSheet open={!!rollbackTarget} onOpenChange={(open) => { if (!open) { setRollbackTarget(null); setRollbackPreview(null); } }}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Rebuild from this deployment</BottomSheetTitle>
            <BottomSheetDescription>
              This will trigger a full rebuild using the config and code from this deployment. It may take several minutes.
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
              Rebuild from this deployment
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>
    </>
  );
}
