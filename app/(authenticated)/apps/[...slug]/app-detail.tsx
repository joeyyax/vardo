"use client";

import { Fragment, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  Trash2,
  Loader2,
  Plus,
  Play,
  ScrollText,
  X,
  Rocket,
  RotateCcw,
  RefreshCw,
  Square,
  ChevronDown,
  Check,
  GitBranch,
  Undo2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { LogViewer } from "@/components/log-viewer";
import dynamic from "next/dynamic";
import { statusDotColor, envTypeDotColor } from "@/lib/ui/status-colors";
import { AppMetrics } from "./app-metrics";
import { AppBackupHistory } from "@/components/backups/app-backup-history";
import { AppErrors } from "./app-errors";
import { AppStability } from "./app-stability";

const AppTerminal = dynamic(
  () => import("./app-terminal").then((m) => m.AppTerminal),
  { ssr: false },
);
import { EnvEditor } from "@/components/env-editor";
import { VolumesPanel } from "@/components/volumes-panel";
import { CronManager } from "./app-cron";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { systemManagedRefusal } from "@/lib/api/system-managed";
import { isOrgAdmin } from "@/lib/auth/permissions";
import { useAppEvents } from "@/hooks/use-app-events";
import { isRefreshEvent } from "@/lib/bus/refresh";
import type { BusEvent } from "@/lib/bus/events";

// Extracted modules
import { Uptime } from "./timer";
import { AppHeader } from "./app-header";
import { AppUpdatesPanel } from "./app-updates";
import { SectionNav, type SectionGroup } from "@/components/section-nav";
import { NewEnvironmentSheet } from "./new-environment-sheet";
import { AppDeployPanel } from "./app-deploy-panel";
import { useDeploy } from "./hooks/use-deploy";
import { useCancelDeploy, useSlotStatus } from "./hooks/use-app-actions";
import { appActionMenu, type AppAction, type AppActionItem } from "@/lib/ui/app-actions";
import { AppNetworking } from "./app-networking";
import { AppConnect } from "./app-connect";
import { AppSettingsPanel } from "./app-settings-panel";
import { DangerZone, DangerZoneRow } from "@/components/danger-zone";
import { hasAppSettingsPageFields } from "@/lib/ui/app-settings-fields";
import { AppDebug } from "./app-debug";
import { ComposeDetail } from "./compose-detail";
import { AppSecurity } from "./app-security";
import { SystemBadge } from "@/components/system-badge";
import { extractDeployError } from "@/lib/ui/deploy-error";
import { currentStageLabel } from "@/lib/ui/deploy-stage";
import { tabPanelSurface } from "@/lib/ui/tab-panel";
import { cn } from "@/lib/utils";


import type { AppDetailProps, Environment } from "./types";


function buildAppPath(appName: string, environments: Environment[], envId: string | undefined, tab?: string) {
  const env = environments.find((e) => e.id === envId);
  const envSegment = env && env.type !== "production" ? `/${env.name}` : "";
  const base = `/apps/${appName}${envSegment}`;
  return tab && tab !== "deployments" ? `${base}/${tab}` : base;
}

export function AppDetail({ app, orgId, userRole, allTags = [], allParentApps = [], allAppNames = [], orgVarKeys = [], siblings = [], stabilityIncidents = [], restarts = null, lifecycleEvents = [], initialTab = "deployments", initialEnv, initialSubView, featureFlags, parentApp = null }: AppDetailProps) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEnvOpen, setDeleteEnvOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingEnv, setDeletingEnv] = useState(false);

  // New environment sheet state
  const [newEnvOpen, setNewEnvOpen] = useState(false);
  const [newEnvCloneDefault, setNewEnvCloneDefault] = useState<string>("__production");

  // Environment selection — persist via URL path segment (/apps/{slug}/{env}/{tab})
  // With the environments flag off, the app is pinned to production.
  const envsEnabled = featureFlags?.environments !== false;
  const productionEnv = app.environments.find((e) => e.type === "production");
  const initialEnvId = (() => {
    if (initialEnv && envsEnabled) {
      const match = app.environments.find((e) => e.name === initialEnv);
      if (match) return match.id;
    }
    return productionEnv?.id;
  })();
  const [selectedEnvId, setSelectedEnvIdRaw] = useState<string | undefined>(initialEnvId);
  const [activeTab, setActiveTabState] = useState(initialTab);

  const setActiveTab = useCallback((tab: string) => {
    setActiveTabState(tab);
    window.history.replaceState({}, "", buildAppPath(app.name, app.environments, selectedEnvId, tab));
  }, [app.name, app.environments, selectedEnvId]);

  // Wrap setSelectedEnvId to also update URL path
  const setSelectedEnvId = useCallback((envId: string | undefined) => {
    setSelectedEnvIdRaw(envId);
    window.history.replaceState({}, "", buildAppPath(app.name, app.environments, envId, activeTab));
  }, [app.environments, app.name, activeTab]);

  const selectedEnv = app.environments.find((e) => e.id === selectedEnvId)
    ?? productionEnv;
  // If selectedEnvId doesn't match any environment, reset to production
  useEffect(() => {
    if (selectedEnvId && !app.environments.find((e) => e.id === selectedEnvId)) {
      setSelectedEnvId(productionEnv?.id);
    }
  }, [selectedEnvId, app.environments, productionEnv?.id, setSelectedEnvId]);

  const isProduction = !selectedEnv || selectedEnv.type === "production";
  // Filter deployments by selected environment
  // Legacy deploys (environmentId=null) only show under production
  const filteredDeployments = selectedEnvId
    ? app.deployments.filter((d) =>
        d.environmentId === selectedEnvId ||
        (isProduction && d.environmentId === null)
      )
    : app.deployments;

  // Detect in-progress deployment from server data (arrived mid-deploy)
  // Note: the deploy hook handles the "don't re-attach if already deploying" logic internally
  const serverRunningDeploy = app.deployments.find((d) => d.status === "running" || d.status === "queued") ?? null;

  const deploy = useDeploy({
    orgId,
    appId: app.id,
    selectedEnvId,
    serverRunningDeploy,
    onDeployStarted: () => setActiveTab("deployments"),
  });

  const handleDeploy = deploy.handleDeploy;

  const handleRestart = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/restart`, { method: "POST" });
      const data = await res.json();
      // Compose can exit clean and leave the app crashed, and a restart never
      // applies pending config. Either one makes a bare "Restarted" a lie.
      const notes = [
        data.observed && data.observed !== "active" ? `Docker reports it ${data.observed}.` : null,
        app.needsRedeploy ? "Config changed since the last deploy — deploy to apply it." : null,
      ].filter(Boolean);

      if (!data.success) {
        toast.error(data.error || "Restart failed");
      } else if (notes.length > 0) {
        toast.warning("Restarted", { description: notes.join(" ") });
      } else {
        toast.success("Restarted");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restart failed");
    }
    router.refresh();
  }, [orgId, app.id, app.needsRedeploy, router]);

  // Same endpoint as Restart: the route reads the app's status and brings a
  // stopped one up rather than restarting nothing.
  const handleStart = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/restart`, { method: "POST" });
      const data = await res.json();
      if (!data.success) toast.error(data.error || "Start failed");
      else if (data.observed && data.observed !== "active") {
        toast.warning("Started", { description: `Docker reports it ${data.observed}.` });
      } else toast.success("Started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Start failed");
    }
    router.refresh();
  }, [orgId, app.id, router]);

  const handleRecreate = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/recreate`, { method: "POST" });
      const data = await res.json();
      data.success ? toast.success("Recreated") : toast.error(data.error || "Recreate failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Recreate failed");
    }
    router.refresh();
  }, [orgId, app.id, router]);

  const { cancelling, cancelDeploy } = useCancelDeploy(orgId, app.id);

  // Child services are stack-level operations managed from the parent
  const isChildService = !!app.parentAppId;

  // Decides which settings pages have anything to show, so an empty one keeps
  // out of the rail.
  const settingsFieldContext = {
    isComposeParent: false,
    isChildService,
    deployType: app.deployType,
    storedDeployType: app.deployType,
    source: app.source,
  };

  // Instant rollback is only offered when the standby slot can actually serve.
  const slotStatus = useSlotStatus(orgId, app.id, {
    enabled: !isChildService,
    refreshKey: deploy.deploying,
  });

  const handleInstantRollback = useCallback(async () => {
    setRollbackOpen(false);
    setRollingBack(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/instant-rollback`,
        { method: "POST" },
      );
      const data = await res.json();
      if (res.ok) toast.success("Rolled back to the standby release");
      else toast.error(data.error || "Instant rollback failed");
    } catch {
      toast.error("Instant rollback failed");
    } finally {
      setRollingBack(false);
    }
    router.refresh();
  }, [orgId, app.id, router]);

  // Real-time updates from the app's event stream, with a polling fallback
  useAppEvents({
    orgId,
    appId: app.id,
    onEvent: useCallback(
      (event: BusEvent) => {
        if (isRefreshEvent(event.type)) router.refresh();
      },
      [router],
    ),
    onFallback: useCallback(() => router.refresh(), [router]),
  });

  const canDelete = isOrgAdmin(userRole);

  async function handleStop() {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/stop`, { method: "POST" });
      const data = await res.json();
      data.success ? toast.success("Stopped") : toast.error(data.error || "Stop failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stop failed");
    }
    router.refresh();
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete");
        return;
      }

      toast.success("App deleted");
      router.push("/projects");
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteEnvironment() {
    if (!selectedEnvId || isProduction) return;
    setDeletingEnv(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/environments`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environmentId: selectedEnvId }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete environment");
        return;
      }

      toast.success(`Environment "${selectedEnv?.name}" deleted`);
      setSelectedEnvId(productionEnv?.id);
      setDeleteEnvOpen(false);
      router.refresh();
    } catch {
      toast.error("Failed to delete environment");
    } finally {
      setDeletingEnv(false);
    }
  }

  // Compose parents share the app-page shell; ComposeDetail supplies the
  // stack-specific sections and aggregates.
  if (app.childApps && app.childApps.length > 0) {
    return (
      <ComposeDetail
        app={{ ...app, childApps: app.childApps }}
        orgId={orgId}
        userRole={userRole}
        initialTab={initialTab}
        initialSubView={initialSubView}
        featureFlags={featureFlags}
        allTags={allTags}
        siblings={siblings}
        stabilityIncidents={stabilityIncidents}
        restarts={restarts}
        lifecycleEvents={lifecycleEvents}
        allParentApps={allParentApps}
      />
    );
  }

  // Set when the API would 403 the stop, so the menu offers it disabled with the reason.
  const stopRefusal = systemManagedRefusal(app, "stop");

  // Same for delete, which the Danger Zone states rather than offering a button
  // that fails.
  const deleteRefusal = systemManagedRefusal(app, "delete");

  // Newest success other than the one serving — what a rollback would restore.
  const rollbackTargetId =
    filteredDeployments.filter((d) => d.status === "success")[1]?.id ?? null;

  const actions = appActionMenu({
    status: app.status,
    isChildService,
    deploying: deploy.deploying,
    standbyAvailable: !!slotStatus?.standbyAvailable,
    hasDeployed: filteredDeployments.length > 0,
    rollbackTarget: !!rollbackTargetId,
    stopRefusal,
  });

  const statusTrigger = (() => {
    if (deploy.deploying || app.status === "deploying") {
      return {
        className: "bg-status-info-muted text-status-info hover:ring-1 hover:ring-inset hover:ring-status-info/40",
        content: <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Deploying</>,
      };
    }
    if (app.status === "active") {
      const lastDeploy = app.deployments.find((d) => d.status === "success");
      return {
        className: app.needsRedeploy
          ? "bg-status-warning-muted text-status-warning hover:ring-1 hover:ring-inset hover:ring-status-warning/40"
          : "bg-status-success-muted text-status-success hover:ring-1 hover:ring-inset hover:ring-status-success/40",
        content: app.needsRedeploy ? (
          <><AlertTriangle className="mr-1.5 size-3.5" />Deploy needed</>
        ) : (
          <>
            <span className="mr-1.5 size-2 rounded-full bg-status-success animate-pulse" />
            Running
            {lastDeploy && <Uptime since={lastDeploy.finishedAt || lastDeploy.startedAt} />}
          </>
        ),
      };
    }
    if (app.status === "stopped") {
      return {
        className: "bg-status-neutral-muted text-status-neutral hover:ring-1 hover:ring-inset hover:ring-status-neutral/40",
        content: <><Square className="mr-1.5 size-3.5" />Stopped</>,
      };
    }
    if (app.status === "missing") {
      return {
        className: "bg-status-warning-muted text-status-warning hover:ring-1 hover:ring-inset hover:ring-status-warning/40",
        content: <><AlertTriangle className="mr-1.5 size-3.5" />No container</>,
      };
    }
    return {
      className: "bg-status-error-muted text-status-error hover:ring-1 hover:ring-inset hover:ring-status-error/40",
      content: <><X className="mr-1.5 size-3.5" />Crashed</>,
    };
  })();

  // Opens the rebuild-from-a-deployment sheet, which lives in the Deployments
  // section alongside the rest of the history.
  function handleRollback() {
    if (!rollbackTargetId) return;
    setActiveTab("deployments");
    deploy.handleRollbackPreview(rollbackTargetId);
  }

  const ACTION_LABEL: Record<AppAction, { icon: LucideIcon; label: string }> = {
    "cancel-deploy": { icon: X, label: "Cancel deploy" },
    deploy: app.status === "error"
      ? { icon: Rocket, label: "Retry deploy" }
      : app.source === "direct"
        ? { icon: Rocket, label: "Deploy" }
        : { icon: GitBranch, label: "Pull latest & redeploy" },
    start: { icon: Play, label: "Start" },
    restart: { icon: RotateCcw, label: "Restart containers" },
    recreate: { icon: RefreshCw, label: "Recreate containers" },
    "instant-rollback": { icon: Zap, label: "Roll back to standby" },
    rollback: { icon: Undo2, label: "Roll back to a previous deploy" },
    logs: { icon: ScrollText, label: "View logs" },
    stop: { icon: Square, label: "Stop" },
  };

  const ACTION_HANDLER: Record<AppAction, () => void> = {
    "cancel-deploy": () => { void cancelDeploy(); },
    deploy: handleDeploy,
    start: handleStart,
    restart: handleRestart,
    recreate: handleRecreate,
    "instant-rollback": () => setRollbackOpen(true),
    rollback: handleRollback,
    logs: () => setActiveTab("logs"),
    stop: () => setStopOpen(true),
  };

  function renderAction(item: AppActionItem, index: number) {
    const { action, disabled } = item;
    const { icon: Icon, label } = ACTION_LABEL[action];
    // One reason under a run of rows sharing it, rather than the same
    // sentence repeated three times.
    const showReason = !!disabled && actions[index + 1]?.disabled !== disabled;
    return (
      <Fragment key={action}>
        {action === "stop" && <DropdownMenuSeparator />}
        <DropdownMenuItem
          disabled={!!disabled || (action === "cancel-deploy" && cancelling) || (action === "instant-rollback" && rollingBack)}
          className={action === "stop" && !disabled ? "text-destructive focus:text-destructive" : undefined}
          onClick={disabled ? undefined : ACTION_HANDLER[action]}
        >
          <Icon className="mr-2 size-4" />
          {label}
        </DropdownMenuItem>
        {showReason && (
          <DropdownMenuLabel className="max-w-72 pt-0 type-body-sm font-normal whitespace-normal text-muted-foreground">
            {disabled}
          </DropdownMenuLabel>
        )}
      </Fragment>
    );
  }

  return (
    <div className="space-y-6">
      {/* Visually-hidden live region for deploy outcome announcements */}
      <span className="sr-only" aria-live="assertive" aria-atomic="true">
        {deploy.deployAnnouncement}
      </span>
      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {/* One action for a never-deployed app is a button, not a menu. */}
            {actions.length === 1 && actions[0].action === "deploy" ? (
              <Button size="sm" disabled={deploy.deploying} onClick={handleDeploy}>
                {deploy.deploying ? (
                  <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
                ) : (
                  <><Rocket className="mr-1.5 size-4" />{app.status === "error" ? "Retry" : "Deploy"}</>
                )}
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className={statusTrigger.className}>
                    {statusTrigger.content}
                    <ChevronDown className="ml-1.5 size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {actions.map(renderAction)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      >
        {isChildService && parentApp ? (
          <>
            <Link
              href={`/apps/${parentApp.name}`}
              className="type-h1 text-muted-foreground hover:text-foreground transition-colors"
            >
              {parentApp.displayName}
            </Link>
            <span className="text-muted-foreground/40 text-xl">›</span>
            <h1 className="type-h1">
              {app.displayName}
            </h1>
          </>
        ) : app.project ? (
          <>
            <Link
              href={`/projects/${app.project.name}`}
              className="type-h1 text-muted-foreground hover:text-foreground transition-colors"
            >
              {app.project.displayName}
            </Link>
            <span className="text-muted-foreground/40 text-xl">›</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <span className={`size-2 rounded-full ${statusDotColor(app.status)}`} />
                  {app.displayName}
                  <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {/* Current app */}
                <DropdownMenuItem disabled>
                  <span className={`mr-2 size-2 rounded-full ${statusDotColor(app.status)}`} />
                  {app.displayName}
                  <Check className="ml-auto size-3.5" />
                </DropdownMenuItem>
                {/* Sibling apps */}
                {siblings.map((sibling) => (
                  <DropdownMenuItem key={sibling.name} asChild>
                    <Link href={`/apps/${sibling.name}`} className="flex items-center gap-2">
                      <span className={`mr-2 size-2 rounded-full ${statusDotColor(sibling.status)}`} />
                      {sibling.displayName}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <h1 className="type-h1">
            {app.displayName}
          </h1>
        )}
        {app.isSystemManaged && <SystemBadge />}
        {!isChildService && envsEnabled && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={`gap-1.5 ${!isProduction ? (
                  selectedEnv?.type === "staging"
                    ? "border-status-warning/40 bg-status-warning-muted text-status-warning"
                    : "border-status-info/40 bg-status-info-muted text-status-info"
                ) : ""}`}
              >
                <span className={`size-2 rounded-full ${envTypeDotColor(selectedEnv?.type ?? "production")}`} />
                {selectedEnv?.name ?? "production"}
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {app.environments.map((env) => (
                <DropdownMenuItem
                  key={env.id}
                  onClick={() => setSelectedEnvId(env.id)}
                >
                  <span className={`mr-2 size-2 rounded-full ${envTypeDotColor(env.type)}`} />
                  {env.name}
                  {env.gitBranch && env.type !== "production" && (
                    <span className="ml-1 text-xs text-muted-foreground font-mono">{env.gitBranch}</span>
                  )}
                  {env.id === selectedEnvId && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-muted-foreground"
                onClick={() => {
                  setNewEnvCloneDefault(
                    isProduction ? "__production" : (selectedEnvId ?? "__production")
                  );
                  setNewEnvOpen(true);
                }}
              >
                <Plus className="mr-2 size-3.5" />
                New environment
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </PageToolbar>

      {/* Error banner — only show if the current environment has a failed deploy */}
      {app.status === "error" && (() => {
        const failedDeploy = filteredDeployments.find((d) => d.status === "failed");
        if (!failedDeploy) return null;
        const errorMessage =
          extractDeployError(failedDeploy.log) || "App crashed — check the deploy log for details";
        return (
          <div className="flex items-start gap-2 rounded-lg bg-status-error-muted px-4 py-2.5 text-sm text-status-error">
            <X className="size-4 shrink-0 mt-0.5" />
            <span
              className="flex-1 line-clamp-3 break-words font-mono text-xs leading-relaxed"
              title={errorMessage}
            >
              {errorMessage}
            </span>
            <div className="flex items-center gap-2 shrink-0 mt-0.5">
              {failedDeploy && (
                <button
                  type="button"
                  onClick={() => { setActiveTab("deployments"); deploy.setViewingLogId(failedDeploy.id); }}
                  className="text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
                >
                  View log
                </button>
              )}
              <button
                type="button"
                disabled={deploy.deploying}
                onClick={handleDeploy}
                className="text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
              >
                Retry
              </button>
            </div>
          </div>
        );
      })()}

      {/* Import rollback banner — shown when an import deploy failed and the original container was restored */}
      {app.importedContainerId && (() => {
        const latestDeploy = filteredDeployments[0];
        if (!latestDeploy || latestDeploy.status !== "rolled_back") return null;
        return (
          <div className="flex items-start gap-2 rounded-lg bg-status-warning-muted px-4 py-2.5 text-sm text-status-warning">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span className="flex-1">
              Rolled back — original container restored. Deploy failed; your original container is running. Redeploy when you&apos;re ready.
            </span>
            <button
              type="button"
              onClick={() => { setActiveTab("deployments"); deploy.setViewingLogId(latestDeploy.id); }}
              className="text-xs underline underline-offset-2 opacity-80 hover:opacity-100 shrink-0 mt-0.5"
            >
              View log
            </button>
          </div>
        );
      })()}

      {/* Environment context banner */}
      {selectedEnv && !isProduction && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm ${
          selectedEnv.type === "staging"
            ? "bg-status-warning-muted text-status-warning"
            : "bg-status-info-muted text-status-info"
        }`}>
          <span className={`size-2 rounded-full ${envTypeDotColor(selectedEnv.type)}`} />
          Viewing <span className="font-medium">{selectedEnv.name}</span> environment
          {filteredDeployments.length === 0 && (
            <span className="text-xs opacity-70 ml-1">— no deployments yet, deploy to get started</span>
          )}
        </div>
      )}

      {/* Heading section — identity + at-a-glance health, persistent across sections */}
      <AppHeader
        app={app}
        orgId={orgId}
        isChildService={isChildService}
        deployments={filteredDeployments}
        allTags={allTags}
        siblings={siblings}
        onNavigate={setActiveTab}
        deployStage={currentStageLabel(deploy.deployStages)}
        stabilityIncidents={stabilityIncidents}
        restarts={restarts}
      />


      {/* Sections — vertical nav rail on lg+, scroll strip below */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        orientation="vertical"
        className="flex-col gap-6 lg:flex-row lg:gap-8"
      >
        <aside className="lg:w-48 lg:shrink-0">
          <div className="lg:sticky lg:top-24">
            <SectionNav
              groups={[
                {
                  items: [
                    ...(!isChildService
                      ? [{ value: "deployments", label: "Deployments", count: filteredDeployments.length }]
                      : []),
                    { value: "updates", label: "Updates" },
                    ...(app.connectionInfo && app.connectionInfo.length > 0
                      ? [{ value: "connect", label: "Connect" }]
                      : []),
                  ],
                },
                {
                  label: "Configure",
                  items: [
                    { value: "variables", label: "Variables", count: app.envVars.length },
                    { value: "networking", label: "Networking" },
                    ...(hasAppSettingsPageFields("build", settingsFieldContext)
                      ? [{ value: "build", label: "Build" }]
                      : []),
                    { value: "resources", label: "Resources" },
                    ...(featureFlags?.cron !== false ? [{ value: "cron", label: "Cron" }] : []),
                    { value: "settings", label: "Settings" },
                  ],
                },
                {
                  label: "Observe",
                  items: [
                    { value: "stability", label: "Stability" },
                    ...(featureFlags?.logging !== false ? [{ value: "logs", label: "Logs" }] : []),
                    ...(featureFlags?.metrics !== false ? [{ value: "metrics", label: "Metrics" }] : []),
                    { value: "errors", label: "Errors" },
                    { value: "security", label: "Security" },
                  ],
                },
                {
                  label: "Data",
                  items: [
                    { value: "volumes", label: "Volumes" },
                    ...(featureFlags?.backups !== false ? [{ value: "backups", label: "Backups" }] : []),
                  ],
                },
                {
                  label: "Tools",
                  items: [
                    ...(featureFlags?.terminal !== false ? [{ value: "terminal", label: "Terminal" }] : []),
                    ...(isOrgAdmin(userRole) ? [{ value: "debug", label: "Debug" }] : []),
                  ],
                },
              ] satisfies SectionGroup[]}
            />
          </div>
        </aside>

        <div className="min-w-0 flex-1">

        <TabsContent value="updates">
          <AppUpdatesPanel
            orgId={orgId}
            appId={app.id}
            appName={app.displayName}
            onDeploy={handleDeploy}
            deploying={deploy.deploying}
            deployed={{ [app.composeService ?? ""]: app.imageName }}
          />
        </TabsContent>

        <TabsContent value="stability">
          <AppStability app={app} incidents={stabilityIncidents} restarts={restarts} />
        </TabsContent>

        <TabsContent value="deployments">
          <AppDeployPanel
            orgId={orgId}
            appId={app.id}
            filteredDeployments={filteredDeployments}
            serverRunningDeploy={serverRunningDeploy}
            appStatus={app.status}
            gitUrl={app.gitUrl}
            source={app.source}
            autoDeploy={app.autoDeploy}
            deploy={deploy}
            onDeploy={handleDeploy}
            deployActionLabel={app.status === "error" ? "Retry" : "Deploy"}
            lifecycleEvents={lifecycleEvents}
          />
        </TabsContent>

        {app.connectionInfo && app.connectionInfo.length > 0 && (
          <TabsContent value="connect">
            <AppConnect
              connectionInfo={app.connectionInfo}
              exposedPorts={app.exposedPorts}
              envVars={app.envVars}
              appName={app.name}
              appId={app.id}
              containerPort={app.containerPort}
            />
          </TabsContent>
        )}

        <TabsContent value="variables" className={cn(tabPanelSurface, "space-y-4")}>
          {isChildService && (
            <p className="text-sm text-muted-foreground">
              These variables apply only to the{" "}
              <span className="font-medium">{app.composeService ?? app.name}</span> service.
            </p>
          )}
          <EnvEditor
            appId={app.id}
            appName={app.name}
            orgId={orgId}
            allAppNames={allAppNames}
            orgVarKeys={orgVarKeys}
          />
        </TabsContent>

        <TabsContent value="networking" className={cn(tabPanelSurface, "space-y-4")}>
          {isChildService && (
            <p className="text-sm text-muted-foreground">
              Domains added here route to the{" "}
              <span className="font-medium">{app.composeService ?? app.name}</span> service.
            </p>
          )}
          <AppNetworking
            domains={app.domains}
            exposedPorts={app.exposedPorts}
            containerPort={app.containerPort}
            appId={app.id}
            appName={app.name}
            orgId={orgId}
            activeTab={activeTab}
            initialSubView={activeTab === "networking" ? initialSubView : undefined}
          />
          {hasAppSettingsPageFields("networking", settingsFieldContext) && (
            <div className="border-t pt-6">
              <AppSettingsPanel
                app={app}
                orgId={orgId}
                userRole={userRole}
                allParentApps={allParentApps}
                handleDeploy={handleDeploy}
                page="networking"
              />
            </div>
          )}
        </TabsContent>

        {featureFlags?.logging !== false && (
          <TabsContent value="logs">
            <LogViewer
              key={`logs-${selectedEnvId}`}
              streamUrl={`/api/v1/organizations/${orgId}/apps/${app.id}/logs/stream${selectedEnv ? `?environment=${selectedEnv.name}` : ""}`}
              initialLevels={initialSubView === "errors" ? ["error"] : undefined}
            />
          </TabsContent>
        )}

        <TabsContent value="volumes" className={tabPanelSurface}>
          <VolumesPanel appId={app.id} orgId={orgId} />
        </TabsContent>

        {featureFlags?.cron !== false && (
          <TabsContent value="cron" className={tabPanelSurface}>
            <CronManager appId={app.id} orgId={orgId} />
          </TabsContent>
        )}

        {hasAppSettingsPageFields("build", settingsFieldContext) && (
          <TabsContent value="build" className={tabPanelSurface}>
            <AppSettingsPanel
              app={app}
              orgId={orgId}
              userRole={userRole}
              allParentApps={allParentApps}
              handleDeploy={handleDeploy}
              page="build"
            />
          </TabsContent>
        )}

        <TabsContent value="resources" className={tabPanelSurface}>
          <AppSettingsPanel
            app={app}
            orgId={orgId}
            userRole={userRole}
            allParentApps={allParentApps}
            handleDeploy={handleDeploy}
            page="resources"
          />
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <div className={tabPanelSurface}>
            <AppSettingsPanel
              app={app}
              orgId={orgId}
              userRole={userRole}
              allParentApps={allParentApps}
              handleDeploy={handleDeploy}
            />
          </div>
          {canDelete && (
            <DangerZone>
              {!isProduction && selectedEnv && (
                <DangerZoneRow
                  title={`Delete ${selectedEnv.name} environment`}
                  description="Removes its variables and deployments. The app itself is untouched."
                  action={
                    <Button size="sm" variant="destructive" onClick={() => setDeleteEnvOpen(true)}>
                      <X className="mr-1.5 size-4" />
                      Delete environment
                    </Button>
                  }
                />
              )}
              <DangerZoneRow
                title="Delete app"
                description={
                  deleteRefusal ??
                  (isChildService
                    ? "Managed by the parent stack — delete the stack to remove this service."
                    : "Removes all environments, deployments, domains and variables. This cannot be undone.")
                }
                action={
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={isChildService || deleteRefusal !== null}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="mr-1.5 size-4" />
                    Delete app
                  </Button>
                }
              />
            </DangerZone>
          )}
        </TabsContent>

        {featureFlags?.terminal !== false && (
          <TabsContent value="terminal" className={cn(tabPanelSurface, "space-y-4")}>
            <p className="text-sm text-muted-foreground">
              Interactive shell session inside the running container. Changes to the filesystem are lost on redeploy unless written to a persistent volume.
            </p>
            <AppTerminal key={`terminal-${selectedEnvId}`} appId={app.id} orgId={orgId} />
          </TabsContent>
        )}

        {featureFlags?.metrics !== false && (
          <TabsContent value="metrics">
            <AppMetrics key={`metrics-${selectedEnvId}`} orgId={orgId} appId={app.id} environmentName={selectedEnv?.name} gpuEnabled={!!app.gpuEnabled} cpuLimit={app.cpuLimit} />
          </TabsContent>
        )}

        {featureFlags?.backups !== false && (
          <TabsContent value="backups" className={cn(tabPanelSurface, "space-y-4")}>
            <p className="text-sm text-muted-foreground">
              Snapshots of this app&apos;s persistent volumes. Download or restore any backup.
            </p>
            <AppBackupHistory orgId={orgId} appId={app.id} />
          </TabsContent>
        )}

        <TabsContent value="security" className={tabPanelSurface}>
          <AppSecurity appId={app.id} orgId={orgId} />
        </TabsContent>

        <TabsContent value="errors" className={cn(tabPanelSurface, "space-y-4")}>
          <AppErrors appName={app.name} appId={app.id} orgId={orgId} />
        </TabsContent>

        {isOrgAdmin(userRole) && (
          <TabsContent value="debug" className={tabPanelSurface}>
            <AppDebug orgId={orgId} appId={app.id} />
          </TabsContent>
        )}
        </div>
      </Tabs>

      {/* New Environment Sheet */}
      {envsEnabled && (
      <NewEnvironmentSheet
        open={newEnvOpen}
        onOpenChange={setNewEnvOpen}
        app={app}
        orgId={orgId}
        productionEnvId={productionEnv?.id}
        defaultCloneFrom={newEnvCloneDefault}
        onSelectEnv={setSelectedEnvId}
      />
      )}

      {/* Stop Confirmation */}
      <ConfirmDeleteDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop app"
        description={`Stop "${app.displayName}"? The app will go offline until you redeploy or restart it.`}
        onConfirm={handleStop}
        confirmLabel="Stop"
      />

      {/* Instant Rollback Confirmation */}
      <ConfirmDeleteDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        title="Roll back to standby"
        description="Swaps live traffic to the standby slot, which is still running the previous release. The current release becomes the standby."
        confirmLabel="Roll back"
        loadingLabel="Rolling back..."
        variant="default"
        loading={rollingBack}
        onConfirm={handleInstantRollback}
      />

      {/* Delete Project Confirmation */}
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete app"
        description={`Are you sure you want to delete "${app.displayName}"? This will remove all environments, deployments, domains, and environment variables. This action cannot be undone.`}
        onConfirm={handleDelete}
        loading={deleting}
      />

      {/* Delete Environment Confirmation */}
      <ConfirmDeleteDialog
        open={deleteEnvOpen}
        onOpenChange={setDeleteEnvOpen}
        title={`Delete ${selectedEnv?.name} environment`}
        description={`Are you sure you want to delete the "${selectedEnv?.name}" environment? This will remove its environment variables and deployments. The app itself will not be affected.`}
        onConfirm={handleDeleteEnvironment}
        loading={deletingEnv}
      />
    </div>
  );
}
