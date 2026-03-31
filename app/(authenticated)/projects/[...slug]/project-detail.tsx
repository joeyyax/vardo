"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus,
  Pencil,
  Rocket,
  Trash2,
  ChevronDown,
  Check,
  EllipsisVertical,
  Loader2,
  RotateCcw,
  Square,
  Variable,
  FileText,
  Activity,
  Wrench,
} from "lucide-react";
import {
  type AppMetrics as AppMetricsType,
  type MetricsHistory,
  EMPTY_HISTORY,
  Sparkline,
  MetricsLine,
  useAppMetrics,
} from "@/components/app-metrics-card";
import { toast } from "@/lib/messenger";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { detectAppType } from "@/lib/ui/app-type";
import { envTypeDotColor } from "@/lib/ui/status-colors";
import { Uptime, StatusIndicator, AppIcon, DeploymentStatusBadge, formatDuration } from "@/components/app-status";
import { ChildAppChipList } from "@/components/child-app-chip";
import { EndpointsPopover } from "@/components/endpoints-popover";
import { LogViewer, DeploymentLog } from "@/components/log-viewer";
import { EnvEditor } from "@/components/env-editor";
import { AppMetrics } from "@/app/(authenticated)/apps/[...slug]/app-metrics";
import { ProjectMetrics } from "./project-metrics";
import { AddAppDropdown } from "../add-app-dropdown";
import { ProjectInstances } from "@/components/mesh/project-instances";
import { AppBackupHistory } from "@/components/backups/app-backup-history";
import { SystemBadge } from "@/components/system-badge";
import type { MeshPeerSummary, ProjectInstanceSummary } from "@/lib/mesh/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GroupEnvironment = {
  id: string;
  name: string;
  type: string;
};

type Deployment = {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled" | "rolled_back" | "superseded";
  trigger: "manual" | "webhook" | "api" | "rollback";
  gitSha: string | null;
  gitMessage: string | null;
  durationMs: number | null;
  log: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  triggeredByUser: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
};

type EnvVar = {
  id: string;
  key: string;
  value: string;
  isSecret: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

type ComposeChildApp = {
  id: string;
  name: string;
  displayName: string;
  composeService: string | null;
  status: string;
  containerName: string | null;
  imageName: string | null;
  dependsOn: string[] | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
  persistentVolumes: { name: string; mountPath: string }[] | null;
};

type ProjectApp = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  status: string;
  needsRedeploy: boolean | null;
  imageName: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  deployType: string;
  source: string;
  dependsOn: string[] | null;
  parentAppId: string | null;
  composeService: string | null;
  containerName: string | null;
  isSystemManaged: boolean;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: Deployment[];
  envVars: EnvVar[];
  childApps?: ComposeChildApp[];
};

type Project = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  color: string | null;
  allowBindMounts: boolean;
  isSystemManaged: boolean;
  apps: ProjectApp[];
  groupEnvironments: GroupEnvironment[];
};

// ---------------------------------------------------------------------------
// Dependency highlight types
// ---------------------------------------------------------------------------

type DepHighlight = "none" | "hovered" | "dependency" | "dependent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// App Card
// ---------------------------------------------------------------------------


function AppCard({
  app,
  color,
  metrics,
  history,
  highlight,
  onHoverStart,
  onHoverEnd,
  childApps = [],
  statusOverride,
}: {
  app: ProjectApp;
  color: string;
  metrics?: AppMetricsType;
  history: MetricsHistory;
  highlight: DepHighlight;
  onHoverStart: () => void;
  onHoverEnd: () => void;
  childApps?: ComposeChildApp[];
  statusOverride?: string;
}) {
  const router = useRouter();
  const effectiveStatus = statusOverride ?? app.status;
  const lastDeploy = app.deployments[0];
  const gitSha = lastDeploy?.gitSha;
  detectAppType(app);
  const cpuData = history.cpu;

  // Source line: repo:branch + sha, or image name
  const sourceLine = app.source === "git" && app.gitUrl
    ? `${app.gitUrl.replace("https://github.com/", "").replace(".git", "")}:${app.gitBranch || "main"}`
    : app.imageName || app.deployType;

  const deps = app.dependsOn ?? [];

  // Build highlight ring/border classes
  const highlightClasses =
    highlight === "hovered"
      ? "ring-2 ring-foreground/20 border-foreground/30 scale-[1.01]"
      : highlight === "dependency"
        ? "ring-2 ring-blue-500/40 border-blue-500/50"
        : highlight === "dependent"
          ? "ring-2 ring-emerald-500/40 border-emerald-500/50"
          : "";

  return (
    <Link
      href={`/apps/${app.name}`}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      className={`squircle relative flex flex-col rounded-lg border bg-card p-4 transition-all duration-200 hover:bg-accent/50 overflow-hidden cursor-pointer ${highlightClasses}`}
    >
      {cpuData.length > 0 && (
        <Sparkline
          data={cpuData}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ color: "oklch(0.65 0.19 255)" }}
        />
      )}

      <div className="relative flex gap-3 w-full">
        <AppIcon app={app} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-semibold truncate">
                {app.displayName}
              </h3>
              <EndpointsPopover endpoints={app.domains.map((d) => ({ domain: d.domain }))} />
            </div>
            <StatusIndicator status={effectiveStatus} finishedAt={lastDeploy?.finishedAt} needsRedeploy={!!app.needsRedeploy} />
          </div>
          {app.description ? (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {app.description}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground/40 truncate mt-0.5">
              {app.name}
            </p>
          )}
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground/40 font-mono truncate">
              {sourceLine}
            </span>
            {gitSha && (
              <code className="text-[10px] font-mono bg-muted px-1 py-0.5 rounded text-muted-foreground shrink-0">
                {gitSha.slice(0, 7)}
              </code>
            )}
          </div>
          {metrics && <MetricsLine metrics={metrics} onHover={() => {}} />}
        </div>
      </div>

      {/* Dependency badges */}
      {deps.length > 0 && (
        <div className="relative flex flex-wrap items-center gap-1 mt-2 pt-2 border-t border-border/50">
          <span className="text-[10px] text-muted-foreground/60 mr-0.5">depends on</span>
          {deps.map((dep) => (
            <span
              key={dep}
              className="inline-flex items-center rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400"
            >
              {dep}
            </span>
          ))}
        </div>
      )}

      {/* Direction indicator when highlighted via hover */}
      {highlight === "dependency" && (
        <div className="relative flex items-center gap-1 mt-1.5 text-[10px] text-blue-600 dark:text-blue-400">
          <span>&larr;</span>
          <span>depends on this</span>
        </div>
      )}
      {highlight === "dependent" && (
        <div className="relative flex items-center gap-1 mt-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
          <span>&rarr;</span>
          <span>depends on this</span>
        </div>
      )}

      {/* Compose service chips */}
      <ChildAppChipList childApps={childApps} />
    </Link>
  );
}


// ---------------------------------------------------------------------------
// Deployments Tab (merged across apps)
// ---------------------------------------------------------------------------

function ProjectDeployments({ apps, color }: { apps: ProjectApp[]; color: string }) {
  const [viewingLogId, setViewingLogId] = useState<string | null>(null);

  const allDeployments = apps
    .flatMap((app) =>
      app.deployments.map((d) => ({ ...d, app }))
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  if (allDeployments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <Rocket className="size-8 text-muted-foreground/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">
            Ready for your first deploy
          </p>
          <p className="text-sm text-muted-foreground">
            Deploy an app from the Apps tab, or push to a connected repo to trigger an automatic deploy.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {allDeployments
        .filter((d) => d.status !== "queued" && d.status !== "running")
        .map((deployment) => {
          const isLatestForApp = deployment.app.deployments[0]?.id === deployment.id;
          const isLive = deployment.status === "success" &&
            deployment.app.status === "active" && isLatestForApp;
          const isStopped = deployment.status === "success" &&
            deployment.app.status === "stopped" && isLatestForApp;
          const isErrored = deployment.status === "success" &&
            deployment.app.status === "error" && isLatestForApp;
          const isSuperseded = deployment.status === "success" &&
            !isLatestForApp && deployment.app.status === "active";

          const bgColor = isLive
            ? "bg-status-success-muted"
            : isStopped
              ? "bg-status-neutral-muted"
              : isErrored
                ? "bg-status-error-muted"
                : deployment.status === "failed"
                  ? "bg-status-error-muted"
                  : "bg-card";

          return (
            <div key={deployment.id} className={`squircle rounded-lg border ${bgColor} overflow-hidden`}>
              <button
                type="button"
                onClick={() => setViewingLogId(viewingLogId === deployment.id ? null : deployment.id)}
                className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {isLive ? (
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
                  ) : isSuperseded ? (
                    <Badge className="border-transparent bg-status-neutral-muted text-status-neutral shrink-0">
                      Superseded
                    </Badge>
                  ) : (
                    <DeploymentStatusBadge status={deployment.status} />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <p className="text-xs font-medium text-muted-foreground shrink-0">
                        {deployment.app.displayName}
                      </p>
                      <p className="text-sm font-medium truncate">
                        {deployment.gitMessage || (
                          <span className="capitalize">{deployment.trigger}</span>
                        )}
                      </p>
                      {deployment.gitSha && (
                        <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">
                          {deployment.gitSha.slice(0, 7)}
                        </code>
                      )}
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
                  {isLive && deployment.finishedAt && (
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
  );
}

// ---------------------------------------------------------------------------
// Variables Tab (per-app editors)
// ---------------------------------------------------------------------------

function ProjectVariables({ apps, orgId }: { apps: ProjectApp[]; orgId: string }) {
  const [expandedApp, setExpandedApp] = useState<string | null>(
    apps.length === 1 ? apps[0].id : null
  );

  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <Variable className="size-8 text-muted-foreground/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No variables to show</p>
          <p className="text-sm text-muted-foreground">Add an app to this project to manage its environment variables.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {apps.map((app) => (
        <div key={app.id} className="squircle rounded-lg border bg-card overflow-hidden">
          <button
            type="button"
            onClick={() => setExpandedApp(expandedApp === app.id ? null : app.id)}
            className="flex items-center justify-between gap-3 p-4 w-full text-left hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-medium">{app.displayName}</h3>
              {app.envVars.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {app.envVars.length}
                </Badge>
              )}
            </div>
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expandedApp === app.id ? "rotate-180" : ""}`} />
          </button>
          {expandedApp === app.id && (
            <div className="border-t p-4">
              <EnvEditor
                appId={app.id}
                appName={app.name}
                orgId={orgId}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs Tab (per-app log streams)
// ---------------------------------------------------------------------------

function ProjectLogs({ apps, orgId }: { apps: ProjectApp[]; orgId: string }) {
  const [selectedApp, setSelectedApp] = useState<string>(apps[0]?.id || "");

  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <FileText className="size-8 text-muted-foreground/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No logs to show</p>
          <p className="text-sm text-muted-foreground">Logs appear here once an app is running in this project.</p>
        </div>
      </div>
    );
  }

  const selected = apps.find((a) => a.id === selectedApp) || apps[0];

  return (
    <div className="space-y-3">
      {apps.length > 1 && (
        <div className="flex gap-1.5">
          {apps.map((app) => (
            <button
              key={app.id}
              type="button"
              onClick={() => setSelectedApp(app.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                selectedApp === app.id
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {app.displayName}
            </button>
          ))}
        </div>
      )}
      <LogViewer
        key={`logs-${selected.id}`}
        streamUrl={`/api/v1/organizations/${orgId}/apps/${selected.id}/logs/stream`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics Tab (combined + individual)
// ---------------------------------------------------------------------------

function ProjectMetricsTab({ apps, orgId, projectId }: { apps: ProjectApp[]; orgId: string; projectId: string }) {
  const [selected, setSelected] = useState<string>("combined");

  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <Activity className="size-8 text-muted-foreground/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No metrics to show</p>
          <p className="text-sm text-muted-foreground">Metrics appear here once an app is running in this project.</p>
        </div>
      </div>
    );
  }

  if (apps.length === 1) {
    return <AppMetrics orgId={orgId} appId={apps[0].id} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => setSelected("combined")}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            selected === "combined"
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-accent"
          }`}
        >
          Combined
        </button>
        {apps.map((app) => (
          <button
            key={app.id}
            type="button"
            onClick={() => setSelected(app.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              selected === app.id
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {app.displayName}
          </button>
        ))}
      </div>

      {selected === "combined" ? (
        <ProjectMetrics orgId={orgId} projectId={projectId} apps={apps} />
      ) : (
        <AppMetrics key={`metrics-${selected}`} orgId={orgId} appId={selected} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectDetail
// ---------------------------------------------------------------------------

export function ProjectDetail({
  project,
  orgId,
  initialTab,
  isAdmin = false,
  meshEnabled = false,
  meshPeers = [],
  projectInstances = [],
}: {
  project: Project;
  orgId: string;
  initialTab: string;
  isAdmin?: boolean;
  meshEnabled?: boolean;
  meshPeers?: MeshPeerSummary[];
  projectInstances?: ProjectInstanceSummary[];
}) {
  const router = useRouter();
  const color = "#a1a1aa"; // neutral — project color is unused
  const { metrics, history } = useAppMetrics(orgId);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOrphanAcknowledged, setDeleteOrphanAcknowledged] = useState(false);
  const [selectedEnv, setSelectedEnv] = useState<string>("production");
  const [newEnvOpen, setNewEnvOpen] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvSaving, setNewEnvSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  // Per-app status overrides for real-time deploy tracking
  const [appStatusOverrides, setAppStatusOverrides] = useState<Map<string, string>>(new Map());
  const eventSourcesRef = useRef<EventSource[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [hoveredAppName, setHoveredAppName] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState(project.displayName);
  const [editDescription, setEditDescription] = useState(project.description || "");
  const [editAllowBindMounts, setEditAllowBindMounts] = useState(project.allowBindMounts);
  const [editSaving, setEditSaving] = useState(false);
  const [stopAllOpen, setStopAllOpen] = useState(false);

  // Filter out compose child apps — they render nested under their parent
  const topLevelApps = useMemo(
    () => project.apps.filter((a) => !a.parentAppId),
    [project.apps]
  );

  const environments = [
    { name: "production", type: "production" },
    ...project.groupEnvironments.map((e) => ({ name: e.name, type: e.type })),
  ];

  // Build reverse dependency map: for each app name, which app names depend on it
  const dependentsMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const app of topLevelApps) {
      for (const dep of app.dependsOn ?? []) {
        const set = map.get(dep) || new Set();
        set.add(app.name);
        map.set(dep, set);
      }
    }
    return map;
  }, [topLevelApps]);

  // Clean up SSE connections and poll timers on unmount
  useEffect(() => {
    return () => {
      eventSourcesRef.current.forEach((es) => es.close());
      eventSourcesRef.current = [];
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  // Subscribe to per-app SSE events for real-time deploy status updates.
  // Sets all apps to "deploying", then listens for deploy:complete on each.
  // Falls back to polling if SSE fails.
  const subscribeToDeployEvents = useCallback(() => {
    // Clean up any previous subscriptions
    eventSourcesRef.current.forEach((es) => es.close());
    eventSourcesRef.current = [];
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    // Set all top-level apps to "deploying" status
    const overrides = new Map<string, string>();
    for (const app of topLevelApps) {
      overrides.set(app.id, "deploying");
    }
    setAppStatusOverrides(new Map(overrides));

    let completedCount = 0;
    const totalApps = topLevelApps.length;

    function handleAppComplete(appId: string, newStatus: string) {
      overrides.set(appId, newStatus);
      setAppStatusOverrides(new Map(overrides));
      completedCount++;
      if (completedCount >= totalApps) {
        // All apps done -- clean up and refresh server data
        eventSourcesRef.current.forEach((es) => es.close());
        eventSourcesRef.current = [];
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setDeploying(false);
        setAppStatusOverrides(new Map());
        router.refresh();
      }
    }

    // Try SSE for each app
    for (const app of topLevelApps) {
      try {
        const eventsUrl = `/api/v1/organizations/${orgId}/apps/${app.id}/events`;
        const es = new EventSource(eventsUrl);
        eventSourcesRef.current.push(es);

        es.addEventListener("deploy:complete", (event) => {
          try {
            const data = JSON.parse(event.data);
            handleAppComplete(app.id, data.status || "active");
          } catch {
            handleAppComplete(app.id, "active");
          }
        });

        es.onerror = () => {
          es.close();
        };
      } catch {
        // SSE not available for this app
      }
    }

    // Fallback: poll the project API every 4 seconds
    const POLL_DELAY = 5000;
    const POLL_INTERVAL = 4000;
    setTimeout(() => {
      pollTimerRef.current = setInterval(async () => {
        if (completedCount >= totalApps) return;
        try {
          const res = await fetch(
            `/api/v1/organizations/${orgId}/projects/${project.id}`,
          );
          if (!res.ok) return;
          const data = await res.json();
          const updatedApps: ProjectApp[] = data.project?.apps ?? [];
          for (const updated of updatedApps) {
            if (updated.parentAppId) continue;
            const current = overrides.get(updated.id);
            if (current === "deploying" && updated.status !== "deploying") {
              handleAppComplete(updated.id, updated.status);
            }
          }
        } catch {
          // Retry on next interval
        }
      }, POLL_INTERVAL);
    }, POLL_DELAY);

    // Safety timeout: if deploys haven't finished after 3 minutes, clean up
    setTimeout(() => {
      if (completedCount < totalApps) {
        eventSourcesRef.current.forEach((es) => es.close());
        eventSourcesRef.current = [];
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setDeploying(false);
        setAppStatusOverrides(new Map());
        router.refresh();
      }
    }, 180000);
  }, [topLevelApps, orgId, project.id, router]);

  // Compute highlight state for each app based on what's hovered
  const getHighlight = useCallback(
    (appName: string): DepHighlight => {
      if (!hoveredAppName) return "none";
      if (appName === hoveredAppName) return "hovered";
      const hoveredApp = topLevelApps.find((a) => a.name === hoveredAppName);
      if (!hoveredApp) return "none";
      // Is this app a dependency of the hovered app?
      if ((hoveredApp.dependsOn ?? []).includes(appName)) return "dependency";
      // Is this app a dependent of the hovered app? (it depends on the hovered one)
      const hoveredDependents = dependentsMap.get(hoveredAppName);
      if (hoveredDependents?.has(appName)) return "dependent";
      return "none";
    },
    [hoveredAppName, topLevelApps, dependentsMap]
  );

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    const path = tab === "apps"
      ? `/projects/${project.name}`
      : `/projects/${project.name}/${tab}`;
    window.history.replaceState(null, "", path);
  }, [project.name]);

  // Count total deployments and env vars for badges
  const totalDeployments = topLevelApps.reduce((sum, app) => sum + app.deployments.length, 0);
  const totalVars = topLevelApps.reduce((sum, app) => sum + app.envVars.length, 0);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete project");
        return;
      }
      toast.success("Project deleted");
      router.push("/projects");
    } catch {
      toast.error("Failed to delete project");
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeployAll() {
    if (topLevelApps.length === 0) return;
    setDeploying(true);
    const firstApp = topLevelApps[0];
    const groupEnvId = selectedEnv !== "production"
      ? project.groupEnvironments.find((e) => e.name === selectedEnv)?.id
      : undefined;
    try {
      const body: Record<string, string | boolean> = { deployAll: true };
      if (groupEnvId) body.groupEnvironmentId = groupEnvId;
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${firstApp.id}/deploy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (res.ok) {
        toast.success("Deploying all apps...");
        // Subscribe to real-time deploy events for status transitions
        subscribeToDeployEvents();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Deploy failed");
        setDeploying(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Deploy failed");
      setDeploying(false);
    }
  }

  async function handleRestartAll() {
    for (const app of topLevelApps) {
      try {
        await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/restart`, { method: "POST" });
      } catch { /* continue */ }
    }
    toast.success("All apps restarted");
    router.refresh();
  }

  async function handleStopAll() {
    for (const app of topLevelApps) {
      try {
        await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/stop`, { method: "POST" });
      } catch { /* continue */ }
    }
    toast.success("All apps stopped");
    router.refresh();
  }

  async function handleEditProject() {
    setEditSaving(true);
    try {
      const body: Record<string, unknown> = {
        displayName: editDisplayName.trim(),
        description: editDescription.trim() || null,
      };
      if (isAdmin) {
        body.allowBindMounts = editAllowBindMounts;
      }
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (res.ok) {
        toast.success("Project updated");
        setEditOpen(false);
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to update");
      }
    } catch {
      toast.error("Failed to update");
    } finally {
      setEditSaving(false);
    }
  }

  async function handleCreateEnv() {
    const name = newEnvName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!name) return;
    setNewEnvSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/environments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type: "staging" }),
        }
      );
      if (res.ok) {
        toast.success(`Environment "${name}" created`);
        setNewEnvOpen(false);
        setNewEnvName("");
        setSelectedEnv(name);
        router.refresh();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to create environment");
      }
    } catch {
      toast.error("Failed to create environment");
    } finally {
      setNewEnvSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {project.isSystemManaged ? (
              <Button size="sm" variant="outline" asChild className="border-status-warning/40 bg-status-warning-muted text-status-warning hover:bg-status-warning/20">
                <Link href="/admin/settings/maintenance">
                  <Wrench className="mr-1.5 size-4" />
                  Manage in Maintenance
                </Link>
              </Button>
            ) : (
              <>
                {topLevelApps.length > 0 && (() => {
                  const allActive = topLevelApps.every((a) => a.status === "active");
                  const anyNeedsRedeploy = topLevelApps.some((a) => a.needsRedeploy);

                  if (allActive && !deploying) {
                    return (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" className={anyNeedsRedeploy
                            ? "bg-status-warning-muted text-status-warning hover:bg-status-warning/20"
                            : "bg-status-success-muted text-status-success hover:bg-status-success/20"
                          }>
                            {anyNeedsRedeploy ? (
                              <><RotateCcw className="mr-1.5 size-3.5" />Restart Needed</>
                            ) : (
                              <><span className="mr-1.5 size-2 rounded-full bg-status-success animate-pulse" />Running</>
                            )}
                            <ChevronDown className="ml-1.5 size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem disabled={deploying} onClick={handleDeployAll}>
                            <Rocket className="mr-2 size-4" />
                            Redeploy All
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={handleRestartAll}>
                            <RotateCcw className="mr-2 size-4" />
                            Restart All
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setStopAllOpen(true)}
                          >
                            <Square className="mr-2 size-4" />
                            Stop All
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    );
                  }

                  return (
                    <Button size="sm" disabled={deploying} onClick={handleDeployAll}>
                      {deploying ? (
                        <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
                      ) : (
                        <><Rocket className="mr-1.5 size-4" />Deploy All</>
                      )}
                    </Button>
                  );
                })()}
                <AddAppDropdown projectId={project.id} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="outline">
                      <EllipsisVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditOpen(true)}>
                      <Pencil className="mr-2 size-4" />
                      Edit project
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="mr-2 size-4" />
                      Delete project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        }
      >
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.displayName}
          </h1>
          {project.isSystemManaged && <SystemBadge />}
          {/* Environment switcher */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <span className={`size-2 rounded-full ${envTypeDotColor(
                  environments.find((e) => e.name === selectedEnv)?.type || "production"
                )}`} />
                {selectedEnv}
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {environments.map((env) => (
                <DropdownMenuItem
                  key={env.name}
                  onClick={() => setSelectedEnv(env.name)}
                >
                  <span className={`mr-2 size-2 rounded-full ${envTypeDotColor(env.type)}`} />
                  {env.name}
                  {env.name === selectedEnv && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-muted-foreground"
                onClick={() => setNewEnvOpen(true)}
              >
                <Plus className="mr-2 size-3.5" />
                New environment
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PageToolbar>

      {project.description && (
        <p className="text-muted-foreground">{project.description}</p>
      )}

      {/* Tabbed sections */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList variant="line">
          <TabsTrigger value="apps">
            Apps
            {topLevelApps.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {topLevelApps.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="deployments">
            Deployments
            {totalDeployments > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {totalDeployments}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="variables">
            Variables
            {totalVars > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {totalVars}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="logs">
            Logs
          </TabsTrigger>
          <TabsTrigger value="metrics">
            Metrics
          </TabsTrigger>
          <TabsTrigger value="backups">
            Backups
          </TabsTrigger>
          {meshEnabled && (
            <TabsTrigger value="instances">
              Instances
              {projectInstances.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs">
                  {projectInstances.length}
                </Badge>
              )}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="apps" className="pt-4">
          {topLevelApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
              <div className="text-center space-y-1">
                <p className="text-sm font-medium">
                  Add your first app
                </p>
                <p className="text-sm text-muted-foreground">
                  Connect a Git repo, Docker image, or Compose file to start deploying.
                </p>
              </div>
              <AddAppDropdown projectId={project.id} align="center" />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {project.apps
                .filter((app) => !app.parentAppId)
                .map((app) => (
                  <AppCard
                    key={app.id}
                    app={app}
                    color={color}
                    metrics={metrics.get(app.id)}
                    history={history.get(app.id) || EMPTY_HISTORY}
                    highlight={getHighlight(app.name)}
                    onHoverStart={() => setHoveredAppName(app.name)}
                    onHoverEnd={() => setHoveredAppName(null)}
                    childApps={app.childApps ?? []}
                    statusOverride={appStatusOverrides.get(app.id)}
                  />
                ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="deployments" className="pt-4">
          <ProjectDeployments apps={topLevelApps} color={color} />
        </TabsContent>

        <TabsContent value="variables" className="pt-4">
          <ProjectVariables apps={topLevelApps} orgId={orgId} />
        </TabsContent>

        <TabsContent value="logs" className="pt-4">
          <ProjectLogs apps={topLevelApps} orgId={orgId} />
        </TabsContent>

        <TabsContent value="metrics" className="pt-4">
          <ProjectMetricsTab apps={topLevelApps} orgId={orgId} projectId={project.id} />
        </TabsContent>

        <TabsContent value="backups" className="pt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Volume snapshots for apps in this project. Download or restore any backup.
          </p>
          {topLevelApps.length > 0 ? (
            <div className="space-y-4">
              {topLevelApps.map((app) => (
                <div key={app.id} className="space-y-2">
                  <h3 className="text-sm font-medium">{app.displayName}</h3>
                  <AppBackupHistory orgId={orgId} appId={app.id} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No apps in this project yet.</p>
          )}
        </TabsContent>

        {meshEnabled && (
          <TabsContent value="instances" className="pt-4">
            <ProjectInstances
              projectId={project.id}
              orgId={orgId}
              peers={meshPeers}
              instances={projectInstances}
            />
          </TabsContent>
        )}
      </Tabs>

      {/* New environment sheet */}
      <BottomSheet open={newEnvOpen} onOpenChange={setNewEnvOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>New Environment</BottomSheetTitle>
            <BottomSheetDescription>
              Create a new environment for all apps in this project.
            </BottomSheetDescription>
          </BottomSheetHeader>
          <div className="p-6 space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="env-name">Name</Label>
              <Input
                id="env-name"
                placeholder="staging, preview, dev..."
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateEnv(); }}
                autoFocus
              />
            </div>
          </div>
          <BottomSheetFooter>
            <Button variant="outline" onClick={() => setNewEnvOpen(false)} disabled={newEnvSaving}>
              Cancel
            </Button>
            <Button onClick={handleCreateEnv} disabled={newEnvSaving || !newEnvName.trim()}>
              {newEnvSaving ? "Creating..." : "Create Environment"}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Edit project sheet */}
      <BottomSheet open={editOpen} onOpenChange={(open) => {
        setEditOpen(open);
        if (!open) {
          setEditDisplayName(project.displayName);
          setEditDescription(project.description || "");
          setEditAllowBindMounts(project.allowBindMounts);
        }
      }}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Edit Project</BottomSheetTitle>
            <BottomSheetDescription>
              Update project name, description, and settings.
            </BottomSheetDescription>
          </BottomSheetHeader>
          <div className="p-6 space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleEditProject(); }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-desc">Description</Label>
              <Input
                id="edit-desc"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Optional description"
                onKeyDown={(e) => { if (e.key === "Enter") handleEditProject(); }}
              />
            </div>
            {isAdmin && (
              <div className="flex items-center justify-between gap-4 pt-2">
                <div className="space-y-1">
                  <Label htmlFor="edit-bind-mounts">Allow bind mounts</Label>
                  <p className="text-xs text-muted-foreground">
                    Permit host path mounts in compose definitions for this project. Enable only for trusted workloads.
                  </p>
                </div>
                <Switch
                  id="edit-bind-mounts"
                  checked={editAllowBindMounts}
                  onCheckedChange={setEditAllowBindMounts}
                />
              </div>
            )}
          </div>
          <BottomSheetFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={editSaving}>
              Cancel
            </Button>
            <Button onClick={handleEditProject} disabled={editSaving || !editDisplayName.trim()}>
              {editSaving ? "Saving..." : "Save"}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Delete confirmation */}
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setDeleteOrphanAcknowledged(false);
        }}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete project"
        description={
          topLevelApps.length > 0
            ? `Deleting "${project.displayName}" will not stop or delete its ${topLevelApps.length} app${topLevelApps.length === 1 ? "" : "s"}. They'll remain running but will no longer be grouped together. You can reassign them to another project from each app's settings.`
            : `Delete the project "${project.displayName}"? This action cannot be undone.`
        }
        confirmDisabled={topLevelApps.length > 0 && !deleteOrphanAcknowledged}
      >
        {topLevelApps.length > 0 && (
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <Checkbox
              checked={deleteOrphanAcknowledged}
              onCheckedChange={(checked) => setDeleteOrphanAcknowledged(checked === true)}
              className="mt-0.5"
            />
            <span className="text-sm text-muted-foreground">
              I understand the {topLevelApps.length === 1 ? "app" : `${topLevelApps.length} apps`} will become unassigned
            </span>
          </label>
        )}
      </ConfirmDeleteDialog>

      {/* Stop All confirmation */}
      <ConfirmDeleteDialog
        open={stopAllOpen}
        onOpenChange={setStopAllOpen}
        onConfirm={handleStopAll}
        title="Stop all apps"
        description={`This will stop all ${topLevelApps.length} running app${topLevelApps.length === 1 ? "" : "s"} in "${project.displayName}". You can restart them at any time.`}
        confirmLabel="Stop All"
      />
    </div>
  );
}
