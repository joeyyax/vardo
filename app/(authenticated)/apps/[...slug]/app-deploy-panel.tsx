"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Loader2,
  Rocket,
  RotateCcw,
  X,
  Zap,
  RefreshCw,
  Play,
  Square,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { splitGitUrl } from "@/lib/api/git-fields";
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
import { DetailPanel, DETAIL_PANEL_GUTTER, PanelSection } from "@/components/detail-panel";
import { ListRow } from "@/components/list-row";
import { StatFilter, StatGroup } from "@/components/stat-filter";
import { StatusDot } from "@/components/ui/status-dot";
import { formatDuration } from "@/lib/metrics/format";
import { toast } from "@/lib/messenger";
import { RelativeTime } from "@/components/relative-time";
import { compactUptime } from "@/lib/ui/app-row";
import { InProgressDeployCard } from "./in-progress-deploy-card";
import { BuildPlanPanel } from "./build-plan-panel";
import { useCancelDeploy } from "./hooks/use-app-actions";
import {
  interleaveHistory,
  partitionLifecycle,
  type LifecycleEvent,
  type LifecycleKind,
} from "@/lib/ui/lifecycle";
import { typicalElapsedMs } from "@/lib/ui/deploy-timing";
import {
  DEPLOY_WINDOW_DAYS,
  deployCounts,
  deployMark,
  deployProblem,
  isDeployFilter,
  matchesDeployFilter,
  triggerLabel,
  type DeployFilter,
  type DeployRole,
} from "@/lib/ui/deploy-list";
import { focusRowByKey, useRowKeys } from "@/hooks/use-row-keys";
import type { UiDensity } from "@/lib/db/schema/enums";

import type { useDeploy } from "./hooks/use-deploy";
import type { Deployment, SlotStatus } from "./types";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { deployAnchor } from "@/lib/ui/hrefs";

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
  /** The toolbar button's action. */
  onDeploy: () => void;
  /** The toolbar button's label. */
  deployActionLabel: string;
  /** Restarts, stops and starts an operator ran, newest first. */
  lifecycleEvents?: LifecycleEvent[];
  /** The tab's URL, or one deploy's when given an id. */
  deployPath: (deploymentId: string | null) => string;
  density?: UiDensity;
}

const LIFECYCLE_ICONS: Record<LifecycleKind, LucideIcon> = {
  restarted: RotateCcw,
  stopped: Square,
  started: Play,
};

/** A non-deploy action on the app's timeline, set between the deploy rows. */
function LifecycleLine({ event }: { event: LifecycleEvent }) {
  const Icon = LIFECYCLE_ICONS[event.kind];
  return (
    <div role="none" className="flex items-center gap-2 py-1.5 pr-2 pl-[30px] text-xs text-muted-foreground">
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="text-foreground/70">{event.label}</span>
      {event.detail && <span className="truncate">{event.detail}</span>}
      {event.notes.map((note) => (
        <span key={note.label} className={`shrink-0 ${note.tone}`} title={note.title}>
          {note.label}
        </span>
      ))}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {event.durationMs != null && <span>took {formatDuration(event.durationMs)}</span>}
        <RelativeTime date={new Date(event.at)} />
      </span>
    </div>
  );
}

/** Client-only so server and client never disagree. */
function LiveFor({ since }: { since: Date | string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setText(compactUptime(since));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [since]);
  return <>live{text && ` for ${text}`}</>;
}

function deployLabel(d: Deployment): string {
  return d.gitMessage || d.gitSha?.slice(0, 7) || triggerLabel(d.trigger);
}

function triggeredBy(d: Deployment): string {
  const by = d.triggeredByUser?.name;
  return by ? `${triggerLabel(d.trigger)} by ${by}` : triggerLabel(d.trigger);
}

function CommitSha({ sha, gitUrl }: { sha: string; gitUrl: string | null }) {
  const commitUrl = gitUrl ? splitGitUrl(gitUrl).url.replace(/\.git$/, "") : null;
  const sha7 = sha.slice(0, 7);
  return commitUrl ? (
    <a
      href={`${commitUrl}/commit/${sha}`}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-brass"
      aria-label={`View commit ${sha7}`}
    >
      {sha7}
    </a>
  ) : (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{sha7}</code>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

const PROBLEM_TONE = { error: "text-status-error", warning: "text-status-warning" } as const;

/** Modal layers own Escape while they are open. */
function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"]');
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
  onDeploy,
  deployActionLabel,
  lifecycleEvents = [],
  deployPath,
  density = "comfortable",
}: AppDeployPanelProps) {
  const {
    deploying,
    deployStages,
    deployStageTimes,
    deployLog,
    deployStartTime,
    expandedDeployLog,
    setExpandedDeployLog,
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
  const {
    cancelling: abortingDeploy,
    cancelRequested,
    setCancelRequested,
    cancelDeploy,
  } = useCancelDeploy(orgId, appId);
  const [slotStatus, setSlotStatus] = useState<SlotStatus | null>(null);
  const [instantRollingBack, setInstantRollingBack] = useState(false);
  const [confirmRollbackOpen, setConfirmRollbackOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onRowKeys = useRowKeys(listRef);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const rawFilter = params.get("show");
  const filter: DeployFilter | null = isDeployFilter(rawFilter) ? rawFilter : null;
  // Read once per render so every row agrees on the window.
  const [now] = useState(() => Date.now());

  // A deploy opened by URL scrolls into view and flashes once.
  const linkedDeploy = useRef(viewingLogId);
  useEffect(() => {
    const id = linkedDeploy.current;
    if (!id) return;
    linkedDeploy.current = null;
    document.getElementById(deployAnchor(id))?.scrollIntoView({ block: "center" });
    setFlash(id);
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, []);

  // The URL names the open deploy, so it can be shared or reopened.
  const syncedOnce = useRef(false);
  useEffect(() => {
    if (!syncedOnce.current) {
      syncedOnce.current = true;
      return;
    }
    const qs = window.location.search;
    window.history.replaceState(null, "", deployPath(viewingLogId) + qs);
  }, [viewingLogId, deployPath]);

  const prevDeploying = useRef(deploying);
  useEffect(() => {
    const wasDeploying = prevDeploying.current;
    prevDeploying.current = deploying;
    if (deploying) return;
    setCancelRequested(false);

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
  }, [orgId, appId, deploying, setCancelRequested]);

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
      } else {
        toast.error(data.error || "Instant rollback failed");
      }
    } catch {
      toast.error("Instant rollback failed");
    } finally {
      setInstantRollingBack(false);
    }
  }, [orgId, appId, router, setConfirmRollbackOpen]);

  // The stream stays open: the engine reports the cancel when it stops.
  const handleAbortDeploy = useCallback(async (deploymentId?: string) => {
    await cancelDeploy(deploymentId);
    router.refresh();
  }, [cancelDeploy, router]);

  const handleCancelQueued = useCallback(async (deploymentId: string) => {
    setCancellingIds((prev) => new Set(prev).add(deploymentId));
    try {
      await cancelDeploy(deploymentId);
      router.refresh();
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(deploymentId);
        return next;
      });
    }
  }, [cancelDeploy, router]);

  const setFilter = useCallback(
    (next: DeployFilter | null) => {
      const sp = new URLSearchParams(params.toString());
      if (next) sp.set("show", next);
      else sp.delete("show");
      const qs = sp.toString();
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [params, pathname],
  );

  // Containers exist but no deployment records — the app was adopted from Docker.
  const adopted =
    filteredDeployments.length === 0 && (appStatus === "active" || appStatus === "error");

  const queuedDeployments = filteredDeployments
    .filter((d) => d.status === "queued" && d.id !== serverRunningDeploy?.id)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const completedDeployments = filteredDeployments
    .filter((d) => d.status !== "queued" && d.status !== "running");

  // Duration of the last green deploy, the yardstick for the live timer.
  const typicalMs = typicalElapsedMs(completedDeployments);

  // Old slot keeps serving during a deploy.
  const liveDeploy = completedDeployments.find(
    (d) =>
      d.status === "success" &&
      (appStatus === "active" ||
        appStatus === "stopped" ||
        appStatus === "error" ||
        appStatus === "deploying")
  );

  const showRollbackAction =
    slotStatus?.standbyAvailable && (appStatus === "active" || appStatus === "error");

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

  // Lifecycle actions after the live release read above that row.
  const lifecycle = partitionLifecycle(
    lifecycleEvents,
    liveDeploy?.finishedAt ?? liveDeploy?.startedAt ?? null,
  );
  const historyTimeline = interleaveHistory(
    historyDeployments,
    lifecycle.earlier,
    (d) => d.finishedAt ?? d.startedAt,
  );

  const counts = deployCounts(completedDeployments, now);

  const roleOf = (d: Deployment): DeployRole =>
    d.id === liveDeploy?.id ? "live" : d.id === instantRollbackDeploy?.id ? "standby" : d.status === "queued" ? "queued" : "history";

  const viewing = viewingLogId ? filteredDeployments.find((d) => d.id === viewingLogId) ?? null : null;

  const openDeploy = useCallback(
    (id: string) => setViewingLogId(viewingLogId === id ? null : id),
    [viewingLogId, setViewingLogId],
  );

  const closePanel = useCallback(() => {
    const returnTo = viewingLogId;
    setViewingLogId(null);
    if (returnTo) requestAnimationFrame(() => focusRowByKey(listRef.current, returnTo));
  }, [viewingLogId, setViewingLogId]);

  // Escape closes the floating panel; the phone sheet handles its own.
  useEffect(() => {
    if (!viewing) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || overlayOpen()) return;
      closePanel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [viewing, closePanel]);

  function renderRow(deployment: Deployment, role: DeployRole) {
    const mark = deployMark(deployment, role, appStatus);
    const problem = deployProblem(deployment, role, appStatus);
    const label = deployLabel(deployment);
    const sha = deployment.gitSha?.slice(0, 7);
    const isLiveRunning = role === "live" && (appStatus === "active" || appStatus === "deploying");
    const isCancelling = cancellingIds.has(deployment.id);
    const queuePosition = role === "queued" ? queuedDeployments.indexOf(deployment) + 1 : 0;

    const text = problem ? (
      <span className={PROBLEM_TONE[problem.tone]} title={problem.text}>
        {problem.text}
      </span>
    ) : role === "queued" ? (
      `${queuePosition} of ${queuedDeployments.length} in queue`
    ) : isLiveRunning && deployment.finishedAt ? (
      <LiveFor since={deployment.finishedAt} />
    ) : role === "standby" ? (
      "standby"
    ) : null;

    // Phones keep one value: the state when there is one, else the time.
    const status = (
      <span className="flex min-w-0 items-center gap-3 text-muted-foreground/70 tabular-nums">
        {text ? (
          <span className="min-w-0 truncate">{text}</span>
        ) : (
          deployment.durationMs != null && <span className="max-sm:hidden">took {formatDuration(deployment.durationMs)}</span>
        )}
        <RelativeTime date={deployment.startedAt} className={cn("shrink-0", text && "max-sm:hidden")} />
      </span>
    );

    const action =
      role === "queued" ? (
        <Button
          variant="ghost"
          size="sm"
          tabIndex={-1}
          className="h-7 gap-1 px-2 text-xs"
          disabled={isCancelling}
          aria-label={`Cancel ${label}`}
          onClick={() => handleCancelQueued(deployment.id)}
        >
          {isCancelling ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
          Cancel
        </Button>
      ) : role === "standby" && !deploying ? (
        <Button
          variant="outline"
          size="sm"
          tabIndex={-1}
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={instantRollingBack}
          aria-label={`Roll back to ${label}`}
          onClick={() => setConfirmRollbackOpen(true)}
        >
          {instantRollingBack ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
          Roll back
        </Button>
      ) : undefined;

    return (
      <div key={deployment.id} id={deployAnchor(deployment.id)} role="none" className="scroll-mt-28">
        <ListRow
          navKey={deployment.id}
          mark={mark}
          name={label}
          nameTitle={deployment.gitMessage ?? undefined}
          href={deployPath(deployment.id)}
          linkOpens
          signal={[sha && sha !== label ? sha : null, triggeredBy(deployment)].filter(Boolean).join(" · ")}
          status={status}
          action={action}
          selected={viewingLogId === deployment.id}
          flash={flash === deployment.id}
          onOpen={() => openDeploy(deployment.id)}
        />
      </div>
    );
  }

  const filtered = filter ? completedDeployments.filter((d) => matchesDeployFilter(d, filter, now)) : null;
  const filterNoun = filter === "failed" ? "failed deploys" : "rollbacks";

  const statFilter = (key: DeployFilter, value: number, label: string, tone: string) => (
    <StatFilter
      id={`deploy-stat-${key}`}
      value={value}
      label={label}
      tone={value ? tone : undefined}
      pressed={filter === key}
      controls="deploy-list"
      onPress={() => setFilter(filter === key ? null : key)}
    />
  );

  const viewingRole = viewing ? roleOf(viewing) : null;
  const viewingMark = viewing && viewingRole ? deployMark(viewing, viewingRole, appStatus) : null;
  const viewingProblem = viewing && viewingRole ? deployProblem(viewing, viewingRole, appStatus) : null;

  return (
    <>
      <div
        data-density={density}
        data-healthy={density === "dense" ? undefined : "quiet"}
        className={cn("grid grid-cols-1 gap-(--section-gap)", viewing && DETAIL_PANEL_GUTTER)}
      >
        {filteredDeployments.length === 0 && !deploying && !serverRunningDeploy ? (
          <>
            {/* A compose child never deploys on its own — these are all it has. */}
            {lifecycleEvents.length > 0 && (
              <Card variant="surface" className="py-1">
                {lifecycleEvents.map((event) => (
                  <LifecycleLine key={event.id} event={event} />
                ))}
              </Card>
            )}
            <EmptyState
              icon={Rocket}
              title={adopted ? "Running, but never deployed from here" : "Ready for your first deploy"}
              body={
                adopted
                  ? "These containers were adopted from Docker, so there is no deploy history to show. Deploying records one and unlocks rollback."
                  : source === "git" && autoDeploy
                    ? "Push to your connected repo to trigger an automatic deploy, or deploy now."
                    : "Nothing has shipped yet."
              }
              action={
                <Button size="sm" disabled={deploying} onClick={onDeploy}>
                  {deploying ? (
                    <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
                  ) : (
                    <><Rocket className="mr-1.5 size-4" />{deployActionLabel}</>
                  )}
                </Button>
              }
            />
          </>
        ) : (
          <>
            {completedDeployments.length > 0 && (
              <StatGroup label="Deploy numbers" active={!!filter || (!!liveDeploy && viewingLogId === liveDeploy.id)}>
                <StatFilter
                  id="deploy-stat-live"
                  value={liveDeploy ? <RelativeTime date={liveDeploy.startedAt} /> : "None"}
                  label={liveDeploy ? "live release" : "nothing live"}
                  tone={appStatus === "error" ? "text-status-error" : undefined}
                  pressed={!!liveDeploy && viewingLogId === liveDeploy.id}
                  controls="deploy-list"
                  onPress={() => liveDeploy && openDeploy(liveDeploy.id)}
                />
                {statFilter("failed", counts.failed, `failed in ${DEPLOY_WINDOW_DAYS} days`, "text-status-error")}
                {statFilter("rollbacks", counts.rollbacks, `${counts.rollbacks === 1 ? "rollback" : "rollbacks"} in ${DEPLOY_WINDOW_DAYS} days`, "text-status-warning")}
              </StatGroup>
            )}

            {/* In-progress deploys */}
            {deploying && (
              <InProgressDeployCard
                stages={deployStages}
                stageTimes={deployStageTimes}
                log={deployLog}
                startTime={deployStartTime}
                expanded={expandedDeployLog}
                onToggleExpand={() => setExpandedDeployLog(!expandedDeployLog)}
                onAbort={() => handleAbortDeploy()}
                canAbort={!abortingDeploy}
                cancelling={cancelRequested}
                typicalElapsedMs={typicalMs}
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
                cancelling={cancelRequested}
                trigger={serverRunningDeploy.trigger}
                typicalElapsedMs={typicalMs}
              />
            )}

            {(completedDeployments.length > 0 || queuedDeployments.length > 0) && (
              <Card variant="surface" className="p-1.5">
                <div id="deploy-list" ref={listRef} role="tree" aria-label="Deployments" onKeyDown={onRowKeys}>
                  {filtered ? (
                    <>
                      <div role="none" className="flex flex-wrap items-center gap-x-3 px-2.5 pt-1.5 pb-2 text-[13px] text-muted-foreground">
                        {filtered.length === 0
                          ? `No ${filterNoun} in the last ${DEPLOY_WINDOW_DAYS} days.`
                          : `${filtered.length} ${filtered.length === 1 ? filterNoun.replace(/s$/, "") : filterNoun} in the last ${DEPLOY_WINDOW_DAYS} days`}
                        <button
                          type="button"
                          onClick={() => setFilter(null)}
                          className="rounded-[3px] text-foreground underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-brass"
                        >
                          Show all deploys
                        </button>
                      </div>
                      {filtered.map((d) => renderRow(d, roleOf(d)))}
                    </>
                  ) : (
                    <>
                      {queuedDeployments.map((d) => renderRow(d, "queued"))}
                      {lifecycle.since.map((event) => (
                        <LifecycleLine key={event.id} event={event} />
                      ))}
                      {liveDeploy ? (
                        renderRow(liveDeploy, "live")
                      ) : completedDeployments.length > 0 && !deploying && (
                        <p role="none" className="px-2.5 py-2 pl-[30px] text-[13px] text-muted-foreground">No active deployment</p>
                      )}
                      {instantRollbackDeploy && renderRow(instantRollbackDeploy, "standby")}
                      {historyTimeline.map((item) =>
                        item.kind === "deploy" ? (
                          renderRow(item.deploy, "history")
                        ) : (
                          <LifecycleLine key={item.event.id} event={item.event} />
                        ),
                      )}
                    </>
                  )}
                </div>
              </Card>
            )}
          </>
        )}
      </div>

      <DetailPanel
        ref={panelRef}
        open={!!viewing}
        onClose={closePanel}
        label={viewing ? `Deploy ${deployLabel(viewing)}` : "Deploy"}
        eyebrow={
          viewing && viewingMark ? (
            <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
              <StatusDot tone={viewingMark.tone} pending={viewingMark.pending} className="text-[12.5px]">
                {viewingMark.label}
              </StatusDot>
              <span aria-hidden="true">·</span>
              <RelativeTime date={viewing.startedAt} />
            </div>
          ) : undefined
        }
        title={viewing ? deployLabel(viewing) : ""}
      >
        {viewing && (
          <div data-healthy="quiet" className="grid gap-5">
            {viewingProblem && (
              <p className={cn("text-sm [overflow-wrap:anywhere]", PROBLEM_TONE[viewingProblem.tone])}>{viewingProblem.text}</p>
            )}
            {viewing.postDeployError && (
              <p className="text-sm text-status-warning">
                Deployed and serving, but {viewing.postDeployError.split("\n").join(" · ")}
              </p>
            )}
            {!deploying && (viewingRole === "standby" || (viewingRole === "history" && viewing.status === "success") || viewingRole === "queued") && (
              <div className="flex flex-wrap gap-2">
                {viewingRole === "standby" && (
                  <Button size="sm" disabled={instantRollingBack} onClick={() => setConfirmRollbackOpen(true)}>
                    {instantRollingBack ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                    Roll back to this
                  </Button>
                )}
                {viewingRole === "history" && viewing.status === "success" && (
                  <Button size="sm" variant="outline" onClick={() => handleRollbackPreview(viewing.id)}>
                    <RefreshCw className="size-3.5" />
                    Rebuild
                  </Button>
                )}
                {viewingRole === "queued" && (
                  <Button size="sm" variant="outline" disabled={cancellingIds.has(viewing.id)} onClick={() => handleCancelQueued(viewing.id)}>
                    <X className="size-3.5" />
                    Cancel
                  </Button>
                )}
              </div>
            )}
            <PanelSection title="Details">
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                {viewing.gitSha && (
                  <Fact label="Commit">
                    <CommitSha sha={viewing.gitSha} gitUrl={gitUrl} />
                  </Fact>
                )}
                {viewing.gitMessage && <Fact label="Message">{viewing.gitMessage}</Fact>}
                <Fact label="Started by">{triggeredBy(viewing)}</Fact>
                <Fact label="Started">
                  <RelativeTime date={viewing.startedAt} absoluteFirst />
                </Fact>
                {viewing.durationMs != null && <Fact label="Took">{formatDuration(viewing.durationMs)}</Fact>}
                {viewing.slot && <Fact label="Container set">{viewing.slot}</Fact>}
              </dl>
            </PanelSection>
            {viewing.buildPlan && (
              <div className="-mx-4">
                <BuildPlanPanel plan={viewing.buildPlan} />
              </div>
            )}
            <PanelSection title="Log">
              {viewing.log ? (
                <div className="-mx-2 overflow-hidden rounded-lg">
                  <DeploymentLog log={viewing.log} maxHeight="max-h-[60vh]" />
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">No log output for this deployment.</p>
              )}
            </PanelSection>
          </div>
        )}
      </DetailPanel>

      {/* Rollback confirmation */}
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
            <AlertDialogAction onClick={handleInstantRollback}>
              <Zap className="size-4 mr-2" />
              Roll back now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rebuild preview */}
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
                  <p className="type-h4">Rolling back to</p>
                  <Card variant="inset" className="p-3 space-y-1">
                    <p className="text-sm">{rollbackPreview.gitMessage || "Manual deploy"}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {rollbackPreview.gitSha && (
                        <code className="font-mono bg-muted px-1.5 py-0.5 rounded">
                          {rollbackPreview.gitSha.slice(0, 7)}
                        </code>
                      )}
                      <RelativeTime date={rollbackPreview.deployedAt} absoluteFirst />
                    </div>
                  </Card>
                </div>
                {rollbackPreview.configChanges.length > 0 && (
                  <div className="space-y-2">
                    <p className="type-h4">Config changes</p>
                    <Card variant="inset" className="divide-y text-xs">
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
                    </Card>
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
                      <Card variant="inset" className="p-3 space-y-2 text-xs">
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
                            <span className="text-status-warning font-medium">Changed: </span>
                            {rollbackPreview.envKeyChanges.changed.join(", ")}
                          </div>
                        )}
                        {rollbackPreview.envKeyChanges.added.length === 0 &&
                          rollbackPreview.envKeyChanges.removed.length === 0 &&
                          rollbackPreview.envKeyChanges.changed.length === 0 && (
                          <span className="text-muted-foreground">No env var changes detected.</span>
                        )}
                      </Card>
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
