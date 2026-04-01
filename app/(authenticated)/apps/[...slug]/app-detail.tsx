"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  Pencil,
  Trash2,
  Loader2,
  Plus,
  X,
  Rocket,
  RotateCcw,
  RefreshCw,
  Square,
  ChevronDown,
  Check,
  Container,
  EllipsisVertical,
  Cpu,
  Wrench,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { PageToolbar } from "@/components/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogViewer } from "@/components/log-viewer";
import dynamic from "next/dynamic";
import { detectAppType } from "@/lib/ui/app-type";
import { statusDotColor, envTypeDotColor } from "@/lib/ui/status-colors";
import { AppMetrics } from "./app-metrics";
import { AppBackupHistory } from "@/components/backups/app-backup-history";

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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isAdmin } from "@/lib/auth/permissions";
import { BranchSelect } from "@/components/branch-select";

// Extracted modules
import { Uptime } from "./timer";
import { DependencySelector } from "./dependency-selector";
import { AppDeployPanel } from "./app-deploy-panel";
import { useDeploy } from "./hooks/use-deploy";
import { AppNetworking } from "./app-networking";
import { AppConnect } from "./app-connect";
import { AppSettingsDialog } from "./app-settings-dialog";
import { AppDebug } from "./app-debug";
import { ComposeDetail } from "./compose-detail";
import { AppSecurity } from "./app-security";
import { SystemBadge } from "@/components/system-badge";

import type { AppDetailProps, Environment } from "./types";


function deployTypeLabel(deployType: string) {
  switch (deployType) {
    case "compose":
      return "Compose";
    case "dockerfile":
      return "Dockerfile";
    case "image":
      return "Image";
    case "static":
      return "Static";
    default:
      return deployType;
  }
}

function buildAppPath(appName: string, environments: Environment[], envId: string | undefined, tab?: string) {
  const env = environments.find((e) => e.id === envId);
  const envSegment = env && env.type !== "production" ? `/${env.name}` : "";
  const base = `/apps/${appName}${envSegment}`;
  return tab && tab !== "deployments" ? `${base}/${tab}` : base;
}

export function AppDetail({ app, orgId, userRole, allTags = [], allParentApps = [], allAppNames = [], orgVarKeys = [], siblings = [], initialTab = "deployments", initialEnv, initialSubView, featureFlags, parentApp = null }: AppDetailProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEnvOpen, setDeleteEnvOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingEnv, setDeletingEnv] = useState(false);

  // New environment form state
  const [newEnvOpen, setNewEnvOpen] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvType, setNewEnvType] = useState<"staging" | "preview">("staging");
  const [newEnvCloneFrom, setNewEnvCloneFrom] = useState<string>("__production");
  const [newEnvBranch, setNewEnvBranch] = useState("");
  const [newEnvSaving, setNewEnvSaving] = useState(false);

  // Environment selection — persist via URL path segment (/apps/{slug}/{env}/{tab})
  const productionEnv = app.environments.find((e) => e.type === "production");
  const initialEnvId = (() => {
    if (initialEnv) {
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
      data.success ? toast.success("Restarted") : toast.error(data.error || "Restart failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restart failed");
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

  // Real-time updates via SSE (Redis pub/sub), with polling fallback
  useEffect(() => {
    const eventsUrl = `/api/v1/organizations/${orgId}/apps/${app.id}/events`;
    let es: EventSource | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;

    try {
      es = new EventSource(eventsUrl);

      es.addEventListener("deploy:complete", () => {
        router.refresh();
      });

      es.addEventListener("deploy:rolled_back", () => {
        router.refresh();
      });

      es.onerror = () => {
        es?.close();
        es = null;
        if (!fallbackInterval) {
          fallbackInterval = setInterval(() => router.refresh(), 10000);
        }
      };
    } catch {
      fallbackInterval = setInterval(() => router.refresh(), 10000);
    }

    return () => {
      es?.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, orgId]);

  // Tag management state
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [togglingTagId, setTogglingTagId] = useState<string | null>(null);

  const appTagIds = new Set(
    (app.appTags ?? []).map((pt) => pt.tag.id)
  );

  async function handleToggleTag(tagId: string) {
    const isApplied = appTagIds.has(tagId);
    setTogglingTagId(tagId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/tags`,
        {
          method: isApplied ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tagId }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to update tag");
        return;
      }
      toast.success(isApplied ? "Tag removed" : "Tag added");
      router.refresh();
    } catch {
      toast.error("Failed to update tag");
    } finally {
      setTogglingTagId(null);
    }
  }

  const canDelete = isAdmin(userRole);

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

  async function handleCreateEnv() {
    const name = newEnvName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!name) return;
    setNewEnvSaving(true);
    try {
      const cloneFrom = newEnvCloneFrom === "__none" ? undefined
        : newEnvCloneFrom === "__production" ? productionEnv?.id
        : newEnvCloneFrom;
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/environments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            type: newEnvType,
            cloneFrom,
            gitBranch: newEnvBranch.trim() || undefined,
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const newEnvId = data.environment.id;
        setSelectedEnvId(newEnvId);
        setNewEnvOpen(false);
        setNewEnvName("");
        setNewEnvBranch("");
        setNewEnvCloneFrom("__production");
        router.refresh();

        // Auto-deploy the new environment
        toast.success(`Environment "${name}" created — deploying...`);
        fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/deploy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environmentId: newEnvId }),
        }).catch(() => {
          toast.error("Auto-deploy failed");
        });
      } else {
        const data = await res.json();
        if (data.error?.includes("already exists")) {
          const existing = app.environments.find((e) => e.name === name);
          if (existing) setSelectedEnvId(existing.id);
          setNewEnvOpen(false);
          toast.info("Environment already exists");
        } else {
          toast.error(data.error || "Failed to create environment");
        }
      }
    } catch {
      toast.error("Failed to create environment");
    } finally {
      setNewEnvSaving(false);
    }
  }

  // Compose parent apps get their own dedicated layout
  if (app.childApps && app.childApps.length > 0) {
    return (
      <ComposeDetail
        app={{ ...app, childApps: app.childApps }}
        orgId={orgId}
        userRole={userRole}
        initialTab={initialTab}
        featureFlags={featureFlags}
      />
    );
  }

  // Child services are stack-level operations managed from the parent
  const isChildService = !!app.parentAppId;

  return (
    <div className="space-y-6">
      {/* Visually-hidden live region for deploy outcome announcements */}
      <span className="sr-only" aria-live="assertive" aria-atomic="true">
        {deploy.deployAnnouncement}
      </span>
      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {!isChildService && (app.status === "active" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className={app.needsRedeploy
                    ? "bg-status-warning-muted text-status-warning hover:bg-status-warning/20"
                    : "bg-status-success-muted text-status-success hover:bg-status-success/20"
                  }>
                    {app.needsRedeploy ? (
                      <AlertTriangle className="mr-1.5 size-3.5" />
                    ) : (
                      <span className="mr-1.5 size-2 rounded-full bg-status-success animate-pulse" />
                    )}
                    {app.needsRedeploy ? "Restart Needed" : "Running"}
                    {!app.needsRedeploy && (() => {
                      const lastDeploy = app.deployments.find((d) => d.status === "success");
                      return lastDeploy ? (
                        <Uptime since={lastDeploy.finishedAt || lastDeploy.startedAt} />
                      ) : null;
                    })()}
                    <ChevronDown className="ml-1.5 size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {app.source === "direct" ? (
                    <>
                      <DropdownMenuItem disabled={deploy.deploying} onClick={handleDeploy}>
                        <Rocket className="mr-2 size-4" />
                        Deploy
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleRestart}>
                        <RotateCcw className="mr-2 size-4" />
                        Restart containers
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleRecreate}>
                        <RefreshCw className="mr-2 size-4" />
                        Rebuild containers
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <>
                      <DropdownMenuItem disabled={deploy.deploying} onClick={handleDeploy}>
                        <Rocket className="mr-2 size-4" />
                        Redeploy
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleRestart}>
                        <RotateCcw className="mr-2 size-4" />
                        Restart
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setStopOpen(true)}
                  >
                    <Square className="mr-2 size-4" />
                    Stop
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="sm" disabled={deploy.deploying} onClick={handleDeploy}>
                {deploy.deploying ? (
                  <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
                ) : (
                  <><Rocket className="mr-1.5 size-4" />{app.status === "error" ? "Retry" : "Deploy"}</>
                )}
              </Button>
            ))}
            {!app.isSystemManaged && (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-1.5 size-4" />
                  Edit
                </Button>
                {canDelete && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="outline"
                      >
                        <EllipsisVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {/* Parent switcher */}
                      {!app.project && allParentApps.length > 0 && (
                        <>
                          <DropdownMenuItem
                            className="text-muted-foreground"
                            onClick={() => setEditOpen(true)}
                          >
                            <Plus className="mr-2 size-3.5" />
                            Assign parent
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      {!isProduction && selectedEnv && (
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteEnvOpen(true)}
                        >
                          <X className="mr-2 size-4" />
                          Delete {selectedEnv.name} environment
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 className="mr-2 size-4" />
                        Delete app
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </>
            )}
          </div>
        }
      >
        {isChildService && parentApp ? (
          <>
            <Link
              href={`/apps/${parentApp.name}`}
              className="text-2xl font-semibold tracking-tight text-muted-foreground hover:text-foreground transition-colors"
            >
              {parentApp.displayName}
            </Link>
            <span className="text-muted-foreground/40 text-xl">›</span>
            <h1 className="text-2xl font-semibold tracking-tight">
              {app.displayName}
            </h1>
          </>
        ) : app.project ? (
          <>
            <Link
              href={`/projects/${app.project.name}`}
              className="text-2xl font-semibold tracking-tight text-muted-foreground hover:text-foreground transition-colors"
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
          <h1 className="text-2xl font-semibold tracking-tight">
            {app.displayName}
          </h1>
        )}
        {app.isSystemManaged && <SystemBadge label="System Managed" />}
        {!isChildService && (
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
                  setNewEnvCloneFrom(
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
        const errorLine = failedDeploy.log
          ?.split("\n")
          .reverse()
          .find((l) => l.includes("ERROR") || l.includes("FATAL") || l.includes("failed") || l.includes("crashed"));
        const cleaned = errorLine
          ?.replace(/^\[.*?\]\s*/, "")
          .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
          .replace(/ghs_[A-Za-z0-9]+/g, "***")
          .trim();
        const errorMessage = cleaned || "App crashed — check the deploy log for details";
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

      {/* Overview */}
      <div className="flex gap-5">
        {/* Project icon */}
        {(() => {
          const { icon: iconUrl } = detectAppType({
            imageName: app.imageName,
            gitUrl: app.gitUrl,
            deployType: app.deployType,
            name: app.name,
            displayName: app.displayName,
          });
          return iconUrl ? (
            <img src={iconUrl} alt="" className="size-12 shrink-0 mt-0.5 opacity-60" />
          ) : (
            <div className="size-12 shrink-0 rounded-lg bg-muted/50 flex items-center justify-center mt-0.5">
              <Container className="size-6 text-muted-foreground/50" />
            </div>
          );
        })()}

        <div className="flex-1 min-w-0 space-y-3">
          {/* Description + domain */}
          {app.description && (
            <p className="text-sm text-muted-foreground">{app.description}</p>
          )}

          {app.domains.length > 0 && (
            <div className="flex items-center gap-2">
              {(() => {
                const primary = app.domains.find((d) => d.isPrimary) || app.domains[0];
                const rest = app.domains.length - 1;
                return (
                  <>
                    <a
                      href={`https://${primary.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {primary.domain}
                    </a>
                    {rest > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveTab("networking")}
                        className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                      >
                        +{rest}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* Source line */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {app.source === "git" && app.gitUrl && (
              <span className="font-mono">
                {app.gitUrl.replace("https://github.com/", "").replace(".git", "")}
                {app.gitBranch && app.gitBranch !== "main" && (
                  <span className="text-muted-foreground/50">:{app.gitBranch}</span>
                )}
              </span>
            )}
            {app.deployType === "image" && app.imageName && (
              <span className="font-mono">{app.imageName}</span>
            )}
            {app.containerPort && (
              <span>:{app.containerPort}</span>
            )}
            <span className="text-muted-foreground/40">
              {deployTypeLabel(app.deployType)}
            </span>
            {app.gpuEnabled && (
              <span className="flex items-center gap-1 text-muted-foreground/70" title="GPU passthrough enabled">
                <Cpu className="size-3" aria-hidden="true" />
                GPU
              </span>
            )}
            <span className="text-muted-foreground/40">
              {new Date(app.createdAt).toLocaleDateString()}
            </span>
          </div>

          {/* Tags */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {(app.appTags ?? []).map(({ tag }) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${tag.color}15`, color: tag.color }}
              >
                <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </span>
            ))}
            {allTags.length > 0 && (
              <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
                <PopoverTrigger asChild>
                  <button className="inline-flex items-center justify-center size-5 rounded-full border border-dashed border-muted-foreground/20 text-muted-foreground/40 hover:text-muted-foreground hover:border-muted-foreground/40 transition-colors">
                    <Plus className="size-2.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-48 p-1.5">
                  {allTags.map((tag) => {
                    const isApplied = appTagIds.has(tag.id);
                    const isToggling = togglingTagId === tag.id;
                    return (
                      <button
                        key={tag.id}
                        disabled={isToggling}
                        onClick={() => handleToggleTag(tag.id)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-50"
                      >
                        <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                        <span className="flex-1 text-left truncate">{tag.name}</span>
                        {isToggling ? <Loader2 className="size-3 animate-spin" /> : isApplied ? <Check className="size-3" /> : null}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>


      {/* Deploy dependencies — only shown for apps in a project with siblings */}
      {app.projectId && siblings.length > 0 && (
        <DependencySelector
          appId={app.id}
          appName={app.name}
          orgId={orgId}
          currentDeps={app.dependsOn ?? []}
          siblings={siblings}
        />
      )}

      {/* Tabbed sections */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          {!isChildService && (
            <TabsTrigger value="deployments">
              Deployments
              {filteredDeployments.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs">
                  {filteredDeployments.length}
                </Badge>
              )}
            </TabsTrigger>
          )}
          {app.connectionInfo && app.connectionInfo.length > 0 && (
            <TabsTrigger value="connect">
              Connect
            </TabsTrigger>
          )}
          {!isChildService && (
            <TabsTrigger value="variables">
              Variables
              {app.envVars.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs">
                  {app.envVars.length}
                </Badge>
              )}
            </TabsTrigger>
          )}
          <TabsTrigger value="networking">
            Networking
          </TabsTrigger>
          <TabsTrigger value="logs">
            Logs
          </TabsTrigger>
          <TabsTrigger value="volumes">
            Volumes
          </TabsTrigger>
          {featureFlags?.cron !== false && (
            <TabsTrigger value="cron">
              Cron
            </TabsTrigger>
          )}
          {featureFlags?.terminal !== false && (
            <TabsTrigger value="terminal">
              Terminal
            </TabsTrigger>
          )}
          <TabsTrigger value="metrics">
            Metrics
          </TabsTrigger>
          {featureFlags?.backups !== false && (
            <TabsTrigger value="backups">
              Backups
            </TabsTrigger>
          )}
          <TabsTrigger value="security">
            Security
          </TabsTrigger>
          {isAdmin(userRole) && (
            <TabsTrigger value="debug">
              Debug
            </TabsTrigger>
          )}
        </TabsList>

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

        <TabsContent value="variables" className="pt-4 space-y-4">
          <EnvEditor
            appId={app.id}
            appName={app.name}
            orgId={orgId}
            allAppNames={allAppNames}
            orgVarKeys={orgVarKeys}
          />
        </TabsContent>

        <TabsContent value="networking">
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
        </TabsContent>

        <TabsContent value="logs" className="pt-4">
          <LogViewer
            key={`logs-${selectedEnvId}`}
            streamUrl={`/api/v1/organizations/${orgId}/apps/${app.id}/logs/stream${selectedEnv ? `?environment=${selectedEnv.name}` : ""}`}
          />
        </TabsContent>

        <TabsContent value="volumes" className="pt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Persistent volumes survive redeploys and container restarts. Data in non-persistent volumes is ephemeral.
          </p>
          <VolumesPanel appId={app.id} orgId={orgId} />
        </TabsContent>

        {featureFlags?.cron !== false && (
          <TabsContent value="cron" className="pt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Schedule commands to run inside this app&apos;s container on a fixed interval. Uses standard cron syntax.
            </p>
            <CronManager appId={app.id} orgId={orgId} />
          </TabsContent>
        )}

        {featureFlags?.terminal !== false && (
          <TabsContent value="terminal" className="pt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Interactive shell session inside the running container. Changes to the filesystem are lost on redeploy unless written to a persistent volume.
            </p>
            <AppTerminal key={`terminal-${selectedEnvId}`} appId={app.id} orgId={orgId} />
          </TabsContent>
        )}

        <TabsContent value="metrics" className="pt-4">
          <AppMetrics key={`metrics-${selectedEnvId}`} orgId={orgId} appId={app.id} environmentName={selectedEnv?.name} gpuEnabled={!!app.gpuEnabled} />
        </TabsContent>

        {featureFlags?.backups !== false && (
          <TabsContent value="backups" className="pt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Snapshots of this app&apos;s persistent volumes. Download or restore any backup.
            </p>
            <AppBackupHistory orgId={orgId} appId={app.id} />
          </TabsContent>
        )}

        <TabsContent value="security">
          <AppSecurity appId={app.id} orgId={orgId} />
        </TabsContent>

        {isAdmin(userRole) && (
          <TabsContent value="debug">
            <AppDebug orgId={orgId} appId={app.id} />
          </TabsContent>
        )}

      </Tabs>

      {/* New Environment Bottom Sheet */}
      <BottomSheet open={newEnvOpen} onOpenChange={setNewEnvOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>New environment</BottomSheetTitle>
            <BottomSheetDescription>
              Create a new environment from a branch. Variables are cloned from the source environment.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-5 py-4">
              {/* Branch + Name */}
              <div className="grid gap-4 sm:grid-cols-2">
                {app.source === "git" ? (
                  <div className="grid gap-2">
                    <Label>Branch</Label>
                    <BranchSelect
                      value={newEnvBranch}
                      onChange={(v) => {
                        const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
                        setNewEnvBranch(v);
                        if (!newEnvName || newEnvName === slugify(newEnvBranch)) {
                          setNewEnvName(slugify(v));
                        }
                      }}
                      appId={app.id}
                      orgId={orgId}
                      excludeBranch={app.gitBranch || "main"}
                    />
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label>Name</Label>
                    <Input
                      placeholder="e.g. staging, qa, demo"
                      value={newEnvName}
                      onChange={(e) => setNewEnvName(e.target.value)}
                    />
                  </div>
                )}
                <div className="grid gap-2">
                  <Label>Environment name</Label>
                  <Input
                    placeholder={app.source === "git" ? "Auto-generated from branch" : "e.g. staging, qa"}
                    value={newEnvName}
                    onChange={(e) => setNewEnvName(e.target.value)}
                  />
                </div>
              </div>

              {/* Clone source */}
              <div className="grid gap-2 sm:w-1/2">
                <Label>Clone variables from</Label>
                <Select value={newEnvCloneFrom} onValueChange={setNewEnvCloneFrom}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__production">Production</SelectItem>
                    {app.environments
                      .filter((e) => e.type !== "production")
                      .map((e) => (
                        <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                      ))}
                    <SelectItem value="__none">Empty (no variables)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => { setNewEnvOpen(false); setNewEnvName(""); setNewEnvBranch(""); setNewEnvCloneFrom("__production"); }}
              disabled={newEnvSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateEnv}
              disabled={!newEnvName.trim() || newEnvSaving || (app.source === "git" && !newEnvBranch.trim())}
            >
              {newEnvSaving ? (
                <><Loader2 className="mr-2 size-4 animate-spin" />Creating...</>
              ) : (
                "Create & Deploy"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Edit Settings Dialog */}
      <AppSettingsDialog
        app={app}
        orgId={orgId}
        userRole={userRole}
        open={editOpen}
        onOpenChange={setEditOpen}
        allParentApps={allParentApps}
        handleDeploy={handleDeploy}
      />

      {/* Stop Confirmation */}
      <ConfirmDeleteDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop app"
        description={`Stop "${app.displayName}"? The app will go offline until you redeploy or restart it.`}
        onConfirm={handleStop}
        confirmLabel="Stop"
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
