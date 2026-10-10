"use client";

import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { Fragment, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { RelativeTime } from "@/components/relative-time";
import {
  Plus,
  Boxes,
  Lock,
  Rocket,
  Trash2,
  ChevronDown,
  Check,
  Loader2,
  RotateCcw,
  Square,
  Variable,
  FileText,
  Activity,
  ChevronsUpDown,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SectionNav, type SectionGroup } from "@/components/section-nav";
import { appHref, deployHref, projectHref } from "@/lib/ui/hrefs";
import Link from "next/link";
import { DetailPanel, DETAIL_PANEL_GUTTER, PanelSection } from "@/components/detail-panel";
import { EntityLink } from "@/components/entity-link";
import { ListRow } from "@/components/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { focusRowByKey, useRowKeys } from "@/hooks/use-row-keys";
import { deployMark, deployProblem, triggerLabel, type DeployRole } from "@/lib/ui/deploy-list";
import type { ProjectsApp } from "@/lib/ui/projects";
import type { UiDensity } from "@/lib/db/schema/enums";
import { ProjectsView } from "../projects-view";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { EmptyState } from "@/components/ui/empty-state";
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
import { summarizeBulkResult, type BulkOutcome } from "@/lib/ui/bulk-result";
import { envTypeDotColor } from "@/lib/ui/status-colors";
import { appStatusFromEvent } from "@/lib/bus/refresh";
import type { BusEvent } from "@/lib/bus/events";
import type { AppCondition } from "@/lib/docker/conditions";
import { formatDuration } from "@/lib/metrics/format";
import { LogViewer, DeploymentLog } from "@/components/log-viewer";
import { EnvEditor } from "@/components/env-editor-lazy";
import { AppMetrics } from "@/app/(authenticated)/apps/[...slug]/app-metrics-lazy";
import { ProjectMetrics } from "./project-metrics";
import { AddAppDropdown } from "../add-app-dropdown";
import { ProjectInstances } from "@/components/mesh/project-instances";
import { AppBackupHistory } from "@/components/backups/app-backup-history";
import { DangerZone, DangerZoneRow } from "@/components/danger-zone";
import { SystemBadge } from "@/components/system-badge";
import { systemManagedRefusal } from "@/lib/api/system-managed";
import { tabPanelSurface } from "@/lib/ui/tab-panel";
import { cn } from "@/lib/utils";
import type { MeshPeerSummary, ProjectInstanceSummary } from "@/lib/mesh/types";
import { Card } from "@/components/ui/card";

type GroupEnvironment = {
  id: string;
  name: string;
  type: string;
};

type Deployment = {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled" | "rolled_back" | "superseded";
  trigger: "manual" | "webhook" | "api" | "rollback" | "relay" | "poll";
  gitSha: string | null;
  gitMessage: string | null;
  durationMs: number | null;
  log: string | null;
  postDeployError: string | null;
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
  parked: boolean;
  containerName: string | null;
  containerStartedAt: Date | null;
  needsRedeploy: boolean | null;
  restartCount: number | null;
  conditions: AppCondition[] | null;
  gpuEnabled: boolean | null;
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
  parked: boolean;
  containerStartedAt: Date | null;
  containerMemoryLimit: number | null;
  needsRedeploy: boolean | null;
  restartCount: number | null;
  conditions: AppCondition[] | null;
  priority: "critical" | "standard" | "disposable" | null;
  gpuEnabled: boolean | null;
  appTags: { tag: { id: string; name: string; color: string } }[];
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
  allowDockerSocket: boolean;
  isSystemManaged: boolean;
  apps: ProjectApp[];
  groupEnvironments: GroupEnvironment[];
};

/** Every app's recent deploys as list rows, newest first. A row opens its log in the panel. */
function ProjectDeployments({ apps }: { apps: ProjectApp[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const onRowKeys = useRowKeys(listRef);
  const [viewing, setViewing] = useState<string | null>(null);

  const all = apps
    .flatMap((app) => app.deployments.map((d) => ({ ...d, app })))
    .filter((d) => d.status !== "queued")
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  const close = useCallback(() => {
    const from = viewing;
    setViewing(null);
    if (from) requestAnimationFrame(() => focusRowByKey(listRef.current, from));
  }, [viewing]);

  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"]')) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewing, close]);

  if (all.length === 0) {
    return (
      <EmptyState
        icon={Rocket}
        title="Ready for your first deploy"
        body="Deploy an app from the Apps tab, or push to a connected repo to trigger an automatic deploy."
      />
    );
  }

  // The newest success of a running app is its live release.
  const roleOf = (d: (typeof all)[number]): DeployRole =>
    d.status === "success" && d.app.deployments.find((x) => x.status === "success")?.id === d.id ? "live" : "history";
  const open = viewing ? all.find((d) => d.id === viewing) ?? null : null;
  const openMark = open ? deployMark(open, roleOf(open), open.app.status) : null;
  const openProblem = open ? deployProblem(open, roleOf(open), open.app.status) : null;

  return (
    <div className={cn("grid grid-cols-1", open && DETAIL_PANEL_GUTTER)}>
      <Card variant="surface" className="p-1.5">
        <div ref={listRef} role="tree" aria-label="Recent deploys" onKeyDown={onRowKeys}>
          {all.map((d) => {
            const role = roleOf(d);
            const problem = deployProblem(d, role, d.app.status);
            const sha = d.gitSha?.slice(0, 7);
            return (
              <ListRow
                key={d.id}
                navKey={d.id}
                mark={deployMark(d, role, d.app.status)}
                name={d.gitMessage || sha || triggerLabel(d.trigger)}
                nameTitle={d.gitMessage ?? undefined}
                href={deployHref(d.app.name, d.id)}
                signal={
                  <>
                    <EntityLink href={appHref(d.app.name)} tabIndex={-1} className="hover:text-foreground">
                      {d.app.displayName}
                    </EntityLink>
                    {sha && sha !== d.gitMessage && ` · ${sha}`}
                  </>
                }
                status={
                  <span className="flex min-w-0 items-center gap-3 text-muted-foreground/70 tabular-nums">
                    {problem ? (
                      <span className={cn("min-w-0 truncate", problem.tone === "error" ? "text-status-error" : "text-status-warning")} title={problem.text}>
                        {problem.text}
                      </span>
                    ) : d.status === "running" ? (
                      <span className="text-status-info">deploying</span>
                    ) : (
                      d.durationMs != null && <span className="max-sm:hidden">took {formatDuration(d.durationMs)}</span>
                    )}
                    <RelativeTime date={d.startedAt} className={cn("shrink-0", problem && "max-sm:hidden")} />
                  </span>
                }
                selected={viewing === d.id}
                onOpen={() => setViewing(viewing === d.id ? null : d.id)}
              />
            );
          })}
        </div>
      </Card>

      <DetailPanel
        open={!!open}
        onClose={close}
        label={open ? `Deploy of ${open.app.displayName}` : "Deploy"}
        eyebrow={
          open && openMark ? (
            <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground">
              <StatusDot tone={openMark.tone} pending={openMark.pending} className="text-[12.5px]">
                {openMark.label}
              </StatusDot>
              <span aria-hidden="true">·</span>
              <EntityLink href={appHref(open.app.name)} className="hover:text-foreground">
                {open.app.displayName}
              </EntityLink>
            </div>
          ) : undefined
        }
        title={open ? open.gitMessage || open.gitSha?.slice(0, 7) || triggerLabel(open.trigger) : ""}
        actions={
          open ? (
            <Button asChild size="sm" variant="ghost">
              <Link href={deployHref(open.app.name, open.id)}>Open in app</Link>
            </Button>
          ) : undefined
        }
      >
        {open && (
          <div className="grid gap-5">
            {openProblem && <p className={cn("text-sm [overflow-wrap:anywhere]", openProblem.tone === "error" ? "text-status-error" : "text-status-warning")}>{openProblem.text}</p>}
            <PanelSection title="Details">
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                {open.gitSha && (
                  <>
                    <dt className="text-muted-foreground">Commit</dt>
                    <dd className="font-mono text-xs">{open.gitSha.slice(0, 7)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Started by</dt>
                <dd>{open.triggeredByUser?.name ? `${triggerLabel(open.trigger)} by ${open.triggeredByUser.name}` : triggerLabel(open.trigger)}</dd>
                <dt className="text-muted-foreground">Started</dt>
                <dd>
                  <RelativeTime date={open.startedAt} absoluteFirst />
                </dd>
                {open.durationMs != null && (
                  <>
                    <dt className="text-muted-foreground">Took</dt>
                    <dd>{formatDuration(open.durationMs)}</dd>
                  </>
                )}
              </dl>
            </PanelSection>
            <PanelSection title="Log">
              {open.log ? (
                <div className="-mx-2 overflow-hidden rounded-lg">
                  <DeploymentLog log={open.log} maxHeight="max-h-[60vh]" />
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">No log output for this deployment.</p>
              )}
            </PanelSection>
          </div>
        )}
      </DetailPanel>
    </div>
  );
}

function ProjectVariables({ apps, orgId }: { apps: ProjectApp[]; orgId: string }) {
  const [expandedApp, setExpandedApp] = useState<string | null>(
    apps.length === 1 ? apps[0].id : null
  );

  if (apps.length === 0) {
    return (
      <EmptyState
        icon={Variable}
        title="No variables to show"
        body="Add an app to this project to manage its environment variables."
      />
    );
  }

  return (
    <div className="space-y-2">
      {apps.map((app) => (
        <Card variant="surface" key={app.id} className="overflow-hidden">
          <button
            type="button"
            onClick={() => setExpandedApp(expandedApp === app.id ? null : app.id)}
            className="flex items-center justify-between gap-3 p-4 w-full text-left hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="type-h4">{app.displayName}</h3>
              {app.envVars.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {app.envVars.length}
                </Badge>
              )}
            </div>
            <DisclosureChevron open={expandedApp === app.id} />
          </button>
          {expandedApp === app.id && (
            <div className="px-4 pb-4">
              <EnvEditor
                appId={app.id}
                appName={app.name}
                orgId={orgId}
              />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function ProjectLogs({ apps, orgId }: { apps: ProjectApp[]; orgId: string }) {
  const [selectedApp, setSelectedApp] = useState<string>(apps[0]?.id || "");

  if (apps.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No logs to show"
        body="Logs appear here once an app is running in this project."
      />
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

function ProjectMetricsTab({ apps, orgId, projectId }: { apps: ProjectApp[]; orgId: string; projectId: string }) {
  const [selected, setSelected] = useState<string>("combined");

  if (apps.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No metrics to show"
        body="Metrics appear here once an app is running in this project."
      />
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

export function ProjectDetail({
  project,
  orgId,
  initialTab,
  canDelete = false,
  canImportContainers = false,
  isInstanceAdmin = false,
  meshEnabled = false,
  loggingEnabled = true,
  environmentsEnabled = true,
  meshPeers = [],
  projectInstances = [],
  listApps,
  density,
}: {
  project: Project;
  orgId: string;
  initialTab: string;
  canDelete?: boolean;
  canImportContainers?: boolean;
  isInstanceAdmin?: boolean;
  meshEnabled?: boolean;
  loggingEnabled?: boolean;
  environmentsEnabled?: boolean;
  meshPeers?: MeshPeerSummary[];
  projectInstances?: ProjectInstanceSummary[];
  /** The apps shaped for the Projects list rows. */
  listApps: ProjectsApp[];
  density: UiDensity;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedEnv, setSelectedEnv] = useState<string>("production");
  const [newEnvOpen, setNewEnvOpen] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvSaving, setNewEnvSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  // Per-app status overrides for real-time deploy tracking
  const [appStatusOverrides, setAppStatusOverrides] = useState<Map<string, string>>(new Map());
  const eventSourcesRef = useRef<EventSource[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [editDisplayName, setEditDisplayName] = useState(project.displayName);
  const [editDescription, setEditDescription] = useState(project.description || "");
  const [editAllowBindMounts, setEditAllowBindMounts] = useState(project.allowBindMounts);
  const [editAllowDockerSocket, setEditAllowDockerSocket] = useState(project.allowDockerSocket);
  const [editSaving, setEditSaving] = useState(false);
  const [stopAllOpen, setStopAllOpen] = useState(false);

  // The API refuses both verbs on Vardo's own project.
  const editRefusal = systemManagedRefusal(project, "edit");
  const deleteRefusal = systemManagedRefusal(project, "delete");

  // Filter out compose child apps — they render nested under their parent
  const topLevelApps = useMemo(
    () => project.apps.filter((a) => !a.parentAppId),
    [project.apps]
  );

  const environments = [
    { name: "production", type: "production" },
    ...project.groupEnvironments.map((e) => ({ name: e.name, type: e.type })),
  ];

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

  // Tracks per-app deploy status over SSE, falling back to polling.
  const subscribeToDeployEvents = useCallback(() => {
    eventSourcesRef.current.forEach((es) => es.close());
    eventSourcesRef.current = [];
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

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

    for (const app of topLevelApps) {
      try {
        const eventsUrl = `/api/v1/organizations/${orgId}/apps/${app.id}/events`;
        const es = new EventSource(eventsUrl);
        eventSourcesRef.current.push(es);

        es.addEventListener("update", (event) => {
          try {
            const data = JSON.parse(event.data) as BusEvent;
            const status = appStatusFromEvent(data);
            if (status) handleAppComplete(app.id, status);
          } catch {
            // Skip malformed events
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

    // Gives up after 3 minutes.
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

  const listProject = useMemo(
    () => ({ id: project.id, name: project.name, displayName: project.displayName, isSystemManaged: project.isSystemManaged }),
    [project.id, project.name, project.displayName, project.isSystemManaged],
  );

  const tabPath = useCallback(
    (tab: string) => (tab === "apps" ? projectHref(project.name) : `${projectHref(project.name)}/${tab}`),
    [project.name],
  );

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", tabPath(tab));
  }, [tabPath]);

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
        toast.error(data.error || "Couldn't delete project");
        return;
      }
      toast.success("Project deleted");
      router.push("/projects");
    } catch {
      toast.error("Couldn't delete project");
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

  // Runs one request per app and collects the names that did not go through.
  async function runOnAllApps(action: "restart" | "stop"): Promise<string[]> {
    const failed: string[] = [];
    for (const app of topLevelApps) {
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/apps/${app.id}/${action}`,
          { method: "POST" }
        );
        if (!res.ok) failed.push(app.displayName || app.name);
      } catch {
        failed.push(app.displayName || app.name);
      }
    }
    return failed;
  }

  function toastBulkResult(outcome: BulkOutcome) {
    toast[outcome.tone](
      outcome.message,
      outcome.description ? { description: outcome.description } : undefined
    );
  }

  async function handleRestartAll() {
    if (topLevelApps.length === 0) return;
    const failed = await runOnAllApps("restart");
    toastBulkResult(
      summarizeBulkResult({
        verb: "restart",
        past: "restarted",
        total: topLevelApps.length,
        failed,
      })
    );
    router.refresh();
  }

  async function handleStopAll() {
    if (topLevelApps.length === 0) return;
    const failed = await runOnAllApps("stop");
    toastBulkResult(
      summarizeBulkResult({
        verb: "stop",
        past: "stopped",
        total: topLevelApps.length,
        failed,
      })
    );
    router.refresh();
  }

  async function handleEditProject() {
    setEditSaving(true);
    try {
      const body: Record<string, unknown> = {
        displayName: editDisplayName.trim(),
        description: editDescription.trim() || null,
      };
      if (isInstanceAdmin) {
        body.allowBindMounts = editAllowBindMounts;
        body.allowDockerSocket = editAllowDockerSocket;
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
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Couldn't update");
      }
    } catch {
      toast.error("Couldn't update");
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
        toast.error(data.error || "Couldn't create environment");
      }
    } catch {
      toast.error("Couldn't create environment");
    } finally {
      setNewEnvSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          // No wrapper: a second flex row clips "Add app" at 320px.
          <>
            {topLevelApps.length > 0 && (() => {
              const allActive = topLevelApps.every((a) => a.status === "active");
              const anyNeedsRedeploy = topLevelApps.some((a) => a.needsRedeploy);

              if (allActive && !deploying) {
                return (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="status" className={anyNeedsRedeploy
                        ? "bg-status-warning-muted text-status-warning hover:ring-status-warning/40"
                        : "bg-status-success-muted text-status-success hover:ring-status-success/40"
                      }>
                        {anyNeedsRedeploy ? (
                          <><RotateCcw className="mr-1.5 size-3.5" />Deploy needed</>
                        ) : (
                          <><span className="mr-1.5 size-2 rounded-full bg-status-success animate-pulse" />Running</>
                        )}
                        <ChevronDown className="ml-1.5 size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={deploying} onClick={handleDeployAll}>
                        <Rocket className="mr-2 size-4" />
                        Redeploy all
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleRestartAll}>
                        <RotateCcw className="mr-2 size-4" />
                        Restart all
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setStopAllOpen(true)}
                      >
                        <Square className="mr-2 size-4" />
                        Stop all
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
                    <><Rocket className="mr-1.5 size-4" />Deploy all</>
                  )}
                </Button>
              );
            })()}
            {!project.isSystemManaged && <AddAppDropdown projectId={project.id} canImportContainers={canImportContainers} />}
          </>
        }
      >
        <div className="flex items-center gap-3">
          <h1 className="type-h1">
            {project.displayName}
          </h1>
          {project.isSystemManaged && <SystemBadge />}
          {/* Environment switcher */}
          {environmentsEnabled && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <span className={`size-2 rounded-full ${envTypeDotColor(
                  environments.find((e) => e.name === selectedEnv)?.type || "production"
                )}`} />
                {selectedEnv}
                <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
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
          )}
        </div>
      </PageToolbar>

      {project.description && (
        <p className="text-muted-foreground">{project.description}</p>
      )}

      {/* Sections */}
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        orientation="vertical"
        className="flex-col gap-6 lg:flex-row lg:gap-8"
      >
        <aside className="lg:w-48 lg:shrink-0">
          <div className="lg:sticky lg:top-24">
            <SectionNav
              label="Project sections"
              hrefFor={tabPath}
              groups={[
                {
                  items: [
                    { value: "apps", label: "Apps", count: topLevelApps.length },
                    { value: "deployments", label: "Deployments", count: totalDeployments },
                  ],
                },
                {
                  label: "Configure",
                  items: [
                    { value: "variables", label: "Variables", count: totalVars },
                    ...(meshEnabled
                      ? [{ value: "instances", label: "Instances", count: projectInstances.length }]
                      : []),
                    { value: "settings", label: "Settings" },
                  ],
                },
                {
                  label: "Observe",
                  items: [
                    ...(loggingEnabled ? [{ value: "logs", label: "Logs" }] : []),
                    { value: "metrics", label: "Metrics" },
                  ],
                },
                {
                  label: "Data",
                  items: [{ value: "backups", label: "Backups" }],
                },
              ] satisfies SectionGroup[]}
            />
          </div>
        </aside>

        <div className="min-w-0 flex-1">

        <TabsContent value="apps">
          {topLevelApps.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="Add your first app"
              body="Connect a Git repo, Docker image or compose file to start deploying."
              action={<AddAppDropdown projectId={project.id} align="center" canImportContainers={canImportContainers} />}
            />
          ) : (
            <ProjectsView
              orgId={orgId}
              apps={listApps.map((a) => (appStatusOverrides.has(a.id) ? { ...a, status: appStatusOverrides.get(a.id)! } : a))}
              projects={[listProject]}
              project={listProject}
              initialDensity={density}
            />
          )}
        </TabsContent>

        <TabsContent value="deployments">
          <ProjectDeployments apps={topLevelApps} />
        </TabsContent>

        <TabsContent value="variables">
          <ProjectVariables apps={topLevelApps} orgId={orgId} />
        </TabsContent>

        {loggingEnabled && (
          <TabsContent value="logs">
            <ProjectLogs apps={topLevelApps} orgId={orgId} />
          </TabsContent>
        )}

        <TabsContent value="metrics">
          <ProjectMetricsTab apps={topLevelApps} orgId={orgId} projectId={project.id} />
        </TabsContent>

        <TabsContent value="backups" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Volume snapshots for apps in this project. Download or restore any backup.
          </p>
          {topLevelApps.length > 0 ? (
            <div className="space-y-4">
              {topLevelApps.map((app) => (
                <div key={app.id} className="space-y-2">
                  <h3 className="type-h4">{app.displayName}</h3>
                  <AppBackupHistory orgId={orgId} appId={app.id} />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No apps in this project yet.</p>
          )}
        </TabsContent>

        {meshEnabled && (
          <TabsContent value="instances">
            <ProjectInstances
              projectId={project.id}
              orgId={orgId}
              peers={meshPeers}
              instances={projectInstances}
              canTransfer={isInstanceAdmin}
            />
          </TabsContent>
        )}

        <TabsContent value="settings" className="space-y-6">
          <fieldset disabled={editRefusal !== null} className={cn(tabPanelSurface, "grid min-w-0 gap-5")}>
            {editRefusal && (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Lock className="mt-0.5 size-4 shrink-0" />
                {editRefusal}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="edit-name">Display name</Label>
                <Input
                  id="edit-name"
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-desc">Description</Label>
                <Input
                  id="edit-desc"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
            {isInstanceAdmin && (
              <div className="flex items-center justify-between gap-4">
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
            {isInstanceAdmin && (
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="edit-docker-socket">Allow Docker socket</Label>
                  <p className="text-xs text-muted-foreground">
                    Permit mounting <span className="font-mono">/var/run/docker.sock</span> in compose definitions (Traefik docker-provider, Dozzle, Watchtower). Grants full control of the host Docker daemon — enable only for trusted workloads.
                  </p>
                </div>
                <Switch
                  id="edit-docker-socket"
                  checked={editAllowDockerSocket}
                  onCheckedChange={setEditAllowDockerSocket}
                />
              </div>
            )}
            {!editRefusal && (
              <div className="flex justify-end pt-2">
                <Button onClick={handleEditProject} disabled={editSaving || !editDisplayName.trim()}>
                  {editSaving ? "Saving..." : "Save changes"}
                </Button>
              </div>
            )}
          </fieldset>

          {canDelete && (
            <DangerZone>
              <DangerZoneRow
                title="Delete project"
                description={
                  deleteRefusal ??
                  (topLevelApps.length > 0
                    ? `Move or delete its ${topLevelApps.length} app${topLevelApps.length === 1 ? "" : "s"} first.`
                    : "This can't be undone.")
                }
                action={
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={deleteRefusal !== null || topLevelApps.length > 0}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="mr-1.5 size-4" />
                    Delete project
                  </Button>
                }
              />
            </DangerZone>
          )}
        </TabsContent>

        </div>
      </Tabs>

      {/* New environment sheet */}
      <BottomSheet open={newEnvOpen} onOpenChange={setNewEnvOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>New environment</BottomSheetTitle>
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
              {newEnvSaving ? "Creating..." : "Create environment"}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Delete confirmation */}
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete project"
        description={`Delete the project "${project.displayName}"? This action can't be undone.`}
      />

      {/* Stop all confirmation */}
      <ConfirmDeleteDialog
        open={stopAllOpen}
        onOpenChange={setStopAllOpen}
        onConfirm={handleStopAll}
        title="Stop all apps"
        description={`This will stop all ${topLevelApps.length} running app${topLevelApps.length === 1 ? "" : "s"} in "${project.displayName}". You can restart them at any time.`}
        confirmLabel="Stop all"
      />
    </div>
  );
}
