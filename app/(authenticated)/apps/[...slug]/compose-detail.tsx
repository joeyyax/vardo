"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Rocket,
  Loader2,
  RotateCcw,
  RefreshCw,
  ChevronDown,
  FileCode2,
  Container,
  Trash2,
  Square,
  EllipsisVertical,
} from "lucide-react";
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
import { LogViewer } from "@/components/log-viewer";
import { EnvEditor } from "@/components/env-editor";
import { AppMetrics } from "./app-metrics";
import { AppBackupHistory } from "@/components/backups/app-backup-history";
import { StatusIndicator, Uptime } from "@/components/app-status";
import { Sparkline, SPARKLINE_POINTS } from "@/components/app-metrics-card";
import { CHART_COLORS } from "@/lib/metrics/constants";
import type { ContainerPoint } from "@/lib/metrics/types";
import { formatBytes } from "@/lib/metrics/format";
import { AppDeployPanel } from "./app-deploy-panel";
import { useDeploy } from "./hooks/use-deploy";
import { isOrgAdmin } from "@/lib/auth/permissions";
import type { App, ChildApp } from "./types";
import type { FeatureFlags } from "@/lib/config/features";
import { ComposeReview } from "@/components/compose-review";

// ---------------------------------------------------------------------------
// Service card for the Services tab
// ---------------------------------------------------------------------------

// Repo de-emphasized, tag as a discrete badge. The badge carries
// data-slot="image-tag" so the image update checker can annotate it.
function ImageRef({ imageName }: { imageName: string }) {
  const slash = imageName.lastIndexOf("/");
  const colon = imageName.lastIndexOf(":");
  const hasTag = colon > slash;
  const repo = hasTag ? imageName.slice(0, colon) : imageName;
  const tag = hasTag ? imageName.slice(colon + 1) : null;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate font-mono text-xs text-muted-foreground/60">{repo}</span>
      <span
        data-slot="image-tag"
        className="shrink-0 rounded border px-1.5 py-px font-mono text-[11px] leading-4 text-muted-foreground"
      >
        {tag ?? "untagged"}
      </span>
    </span>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="type-label text-muted-foreground/70">{label}</span>
      <span className="text-xs tabular-nums truncate">{children}</span>
    </div>
  );
}

function formatPorts(service: ChildApp): string | null {
  const ports = service.exposedPorts?.length
    ? service.exposedPorts
    : service.containerPort
      ? [{ internal: service.containerPort }]
      : [];
  if (ports.length === 0) return null;
  const shown = ports
    .slice(0, 2)
    .map((p) =>
      p.external && p.external !== p.internal ? `${p.external}→${p.internal}` : `${p.internal}`,
    )
    .join(", ");
  return ports.length > 2 ? `${shown} +${ports.length - 2}` : shown;
}

// Stack containers are labeled with the parent app's name, so per-service
// metrics come from the parent stream's container breakdown, matched by name.
function matchServiceContainers(containers: ContainerPoint[], service: ChildApp): ContainerPoint[] {
  const candidates = [service.composeService, service.name].filter(
    (c): c is string => !!c,
  );
  return containers.filter((c) =>
    candidates.some((cand) => {
      if (c.containerName === cand) return true;
      const escaped = cand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`[-_]${escaped}([-_]\\d+)?$`).test(c.containerName);
    }),
  );
}

function ServiceCard({
  service,
  stats,
  cpuHistory,
}: {
  service: ChildApp;
  stats?: { cpuPercent: number; memoryUsage: number };
  cpuHistory?: number[];
}) {
  const primaryDomain = service.domains.find((d) => d.isPrimary) || service.domains[0];
  const running = service.status === "active";
  const ports = formatPorts(service);
  return (
    <Link
      href={`/apps/${service.name}`}
      className="squircle relative flex flex-col rounded-lg border bg-card p-4 transition-all duration-200 hover:bg-accent/50 overflow-hidden cursor-pointer"
    >
      {running && cpuHistory && cpuHistory.length > 1 && (
        <Sparkline
          data={cpuHistory}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ color: CHART_COLORS.cpu }}
        />
      )}

      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="type-h3 truncate">{service.displayName}</h3>
          <p className="font-mono text-xs text-muted-foreground/60 truncate">
            {service.composeService ?? service.name}
          </p>
        </div>
        <StatusIndicator status={service.status} needsRedeploy={!!service.needsRedeploy} />
      </div>

      <div className="relative mt-2 space-y-1">
        {service.imageName && <ImageRef imageName={service.imageName} />}
        {primaryDomain && (
          <p className="font-mono text-xs text-muted-foreground truncate">
            {primaryDomain.domain}
          </p>
        )}
      </div>

      <div className="relative mt-3 grid grid-cols-4 gap-2 border-t pt-3">
        <Stat label="CPU">
          {running && stats ? `${stats.cpuPercent.toFixed(1)}%` : "—"}
        </Stat>
        <Stat label="Mem">
          {running && stats ? formatBytes(stats.memoryUsage) : "—"}
        </Stat>
        <Stat label="Up">
          {running && service.containerStartedAt ? (
            <Uptime since={service.containerStartedAt} />
          ) : (
            "—"
          )}
        </Stat>
        <Stat label="Port">{ports ?? "—"}</Stat>
      </div>
    </Link>
  );
}

// Live per-service stats from the parent app's stream. Mounted only while the
// Services tab is active.
function ComposeServices({
  appId,
  services,
  orgId,
}: {
  appId: string;
  services: ChildApp[];
  orgId: string;
}) {
  // Rolling window of container snapshots; stats and sparklines derive from it.
  const [snapshots, setSnapshots] = useState<ContainerPoint[][]>([]);

  useEffect(() => {
    const es = new EventSource(`/api/v1/organizations/${orgId}/apps/${appId}/stats/stream`);
    const handlePoint = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (Array.isArray(data.containers)) {
          setSnapshots((prev) => [...prev.slice(-(SPARKLINE_POINTS - 1)), data.containers]);
        }
      } catch { /* malformed event */ }
    };
    es.addEventListener("point", handlePoint);
    return () => es.close();
  }, [orgId, appId]);

  const { stats, histories } = useMemo(() => {
    const stats = new Map<string, { cpuPercent: number; memoryUsage: number }>();
    const histories = new Map<string, number[]>();
    const latest = snapshots[snapshots.length - 1] ?? [];
    for (const s of services) {
      const matched = matchServiceContainers(latest, s);
      if (matched.length > 0) {
        stats.set(s.id, {
          cpuPercent: matched.reduce((sum, c) => sum + c.cpuPercent, 0),
          memoryUsage: matched.reduce((sum, c) => sum + c.memoryUsage, 0),
        });
      }
      const hist = snapshots
        .map((snap) => matchServiceContainers(snap, s))
        .filter((m) => m.length > 0)
        .map((m) => m.reduce((sum, c) => sum + c.cpuPercent, 0));
      if (hist.length > 1) histories.set(s.id, hist);
    }
    return { stats, histories };
  }, [snapshots, services]);

  return (
    <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {services.map((service) => (
        <ServiceCard
          key={service.id}
          service={service}
          stats={stats.get(service.id)}
          cpuHistory={histories.get(service.id)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared service selector buttons
// ---------------------------------------------------------------------------

function ServiceSelector({
  services,
  selectedId,
  onSelect,
}: {
  services: ChildApp[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (services.length <= 1) return null;
  return (
    <div role="group" aria-label="Select service" className="flex gap-1.5 flex-wrap">
      {services.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onSelect(s.id)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            selectedId === s.id
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-accent"
          }`}
        >
          {s.displayName}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs tab with per-service selector
// ---------------------------------------------------------------------------

function ComposeLogs({ services, orgId }: { services: ChildApp[]; orgId: string }) {
  const [selectedId, setSelectedId] = useState<string>(services[0]?.id || "");
  const selected = services.find((s) => s.id === selectedId) || services[0];

  if (!selected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">No services to show logs for.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ServiceSelector services={services} selectedId={selectedId} onSelect={setSelectedId} />
      <LogViewer
        key={`logs-${selected.id}`}
        streamUrl={`/api/v1/organizations/${orgId}/apps/${selected.id}/logs/stream`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics tab with per-service selector
// ---------------------------------------------------------------------------

function ComposeMetrics({ services, orgId }: { services: ChildApp[]; orgId: string }) {
  const [selectedId, setSelectedId] = useState<string>(services[0]?.id || "");
  const selected = services.find((s) => s.id === selectedId) || services[0];

  if (!selected) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">No services to show metrics for.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ServiceSelector services={services} selectedId={selectedId} onSelect={setSelectedId} />
      <AppMetrics key={`metrics-${selected.id}`} orgId={orgId} appId={selected.id} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compose editor tab
// ---------------------------------------------------------------------------

function ComposeEditor({
  app,
  orgId,
}: {
  app: App;
  orgId: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(app.composeContent || "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composeContent: value }),
      });
      if (res.ok) {
        toast.success("Compose file saved");
        setEditing(false);
        router.refresh();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!app.composeContent && !editing) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <FileCode2 className="size-8 text-muted-foreground/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No compose file stored</p>
          <p className="text-sm text-muted-foreground">
            Deploy from a git repo to sync the compose file, or paste one below.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          Paste compose file
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground font-mono">
          {app.composeFilePath || "docker-compose.yml"}
        </p>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setEditing(false); setValue(app.composeContent || ""); }}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <>
          <p className="text-xs text-muted-foreground">
            Compose YAML is stored as plaintext. Use the Variables tab for secrets — env vars are encrypted at rest.
          </p>
          <textarea
            className="w-full min-h-96 font-mono text-sm bg-muted/30 border rounded-lg p-4 resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
          />
        </>
      ) : (
        <pre className="w-full overflow-auto bg-muted/30 border rounded-lg p-4 text-sm font-mono text-muted-foreground whitespace-pre-wrap break-words">
          {app.composeContent}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComposeDetail — main component for compose parent apps
// ---------------------------------------------------------------------------

export function ComposeDetail({
  app,
  orgId,
  userRole,
  initialTab,
  featureFlags,
}: {
  app: App & { childApps: NonNullable<App["childApps"]> };
  orgId: string;
  userRole: string;
  initialTab: string;
  featureFlags: FeatureFlags;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);

  const canDelete = isOrgAdmin(userRole);

  const handleRestart = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/restart`, { method: "POST" });
      const data = await res.json();
      data.success ? toast.success("Stack restarted") : toast.error(data.error || "Restart failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restart failed");
    }
    router.refresh();
  }, [orgId, app.id, router]);

  const handleRecreate = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/recreate`, { method: "POST" });
      const data = await res.json();
      data.success ? toast.success("Stack rebuilt") : toast.error(data.error || "Rebuild failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rebuild failed");
    }
    router.refresh();
  }, [orgId, app.id, router]);

  async function handleStop() {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/stop`, { method: "POST" });
      const data = await res.json();
      data.success ? toast.success("Stack stopped") : toast.error(data.error || "Stop failed");
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

  const services = app.childApps;

  const setActiveTabAndUrl = useCallback(
    (tab: string) => {
      setActiveTab(tab);
      const path =
        tab === "services" ? `/apps/${app.name}` : `/apps/${app.name}/${tab}`;
      window.history.replaceState({}, "", path);
    },
    [app.name],
  );

  // Real-time updates via SSE, poll fallback
  useEffect(() => {
    const eventsUrl = `/api/v1/organizations/${orgId}/apps/${app.id}/events`;
    let es: EventSource | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;

    try {
      es = new EventSource(eventsUrl);
      es.addEventListener("deploy:complete", () => router.refresh());
      es.addEventListener("deploy:rolled_back", () => router.refresh());
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

  const serverRunningDeploy =
    app.deployments.find((d) => d.status === "running" || d.status === "queued") ?? null;

  const deploy = useDeploy({
    orgId,
    appId: app.id,
    selectedEnvId: app.environments.find((e) => e.type === "production")?.id,
    serverRunningDeploy,
    onDeployStarted: () => setActiveTabAndUrl("deployments"),
  });

  const [showComposeReview, setShowComposeReview] = useState(false);

  const handleDeployClick = useCallback(() => {
    // Show review for first deploy of compose apps that have content
    if (app.composeContent && app.deployments.length === 0) {
      setShowComposeReview(true);
    } else {
      deploy.handleDeploy();
    }
  }, [app.composeContent, app.deployments.length, deploy]);

  const totalDeployments = app.deployments.length;

  return (
    <div className="space-y-6">
      <span className="sr-only" aria-live="assertive" aria-atomic="true">
        {deploy.deployAnnouncement}
      </span>

      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {app.status === "active" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className={
                      app.needsRedeploy
                        ? "bg-status-warning-muted text-status-warning hover:bg-status-warning/20"
                        : "bg-status-success-muted text-status-success hover:bg-status-success/20"
                    }
                  >
                    {app.needsRedeploy ? (
                      <><RotateCcw className="mr-1.5 size-3.5" />Restart Needed</>
                    ) : (
                      <><span className="mr-1.5 size-2 rounded-full bg-status-success animate-pulse" />Running</>
                    )}
                    <ChevronDown className="ml-1.5 size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={deploy.deploying} onClick={handleDeployClick}>
                    <Rocket className="mr-2 size-4" />
                    Redeploy Stack
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleRestart}>
                    <RotateCcw className="mr-2 size-4" />
                    Restart Stack
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleRecreate}>
                    <RefreshCw className="mr-2 size-4" />
                    Rebuild Stack
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setStopOpen(true)}
                  >
                    <Square className="mr-2 size-4" />
                    Stop Stack
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="sm" disabled={deploy.deploying} onClick={handleDeployClick}>
                {deploy.deploying ? (
                  <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
                ) : (
                  <><Rocket className="mr-1.5 size-4" />Deploy Stack</>
                )}
              </Button>
            )}
            {!app.isSystemManaged && canDelete && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="outline">
                    <EllipsisVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
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
          </div>
        }
      >
        {app.project ? (
          <>
            <Link
              href={`/projects/${app.project.name}`}
              className="type-h1 text-muted-foreground hover:text-foreground transition-colors"
            >
              {app.project.displayName}
            </Link>
            <span className="text-muted-foreground/40 text-xl">›</span>
            <h1 className="type-h1">{app.displayName}</h1>
          </>
        ) : (
          <h1 className="type-h1">{app.displayName}</h1>
        )}
      </PageToolbar>

      {/* Tabbed sections */}
      <Tabs value={activeTab} onValueChange={setActiveTabAndUrl}>
        <TabsList variant="line">
          <TabsTrigger value="services">
            Services
            {services.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {services.length}
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
            {app.envVars.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {app.envVars.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          {featureFlags?.backups !== false && (
            <TabsTrigger value="backups">Backups</TabsTrigger>
          )}
          <TabsTrigger value="compose">Compose</TabsTrigger>
        </TabsList>

        <TabsContent value="services" className="pt-4">
          {services.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
              <Container className="size-8 text-muted-foreground/50" />
              <div className="text-center space-y-1">
                <p className="text-sm font-medium">No services</p>
                <p className="text-sm text-muted-foreground">
                  Deploy the stack to see its services here.
                </p>
              </div>
            </div>
          ) : (
            <ComposeServices appId={app.id} services={services} orgId={orgId} />
          )}
        </TabsContent>

        <TabsContent value="deployments" className="pt-4">
          <AppDeployPanel
            orgId={orgId}
            appId={app.id}
            filteredDeployments={app.deployments}
            serverRunningDeploy={serverRunningDeploy}
            appStatus={app.status}
            gitUrl={app.gitUrl}
            source={app.source}
            autoDeploy={app.autoDeploy}
            deploy={deploy}
          />
        </TabsContent>

        <TabsContent value="variables" className="pt-4 space-y-4">
          <EnvEditor
            appId={app.id}
            appName={app.name}
            orgId={orgId}
          />
        </TabsContent>

        <TabsContent value="logs" className="pt-4">
          <ComposeLogs services={services} orgId={orgId} />
        </TabsContent>

        <TabsContent value="metrics" className="pt-4">
          <ComposeMetrics services={services} orgId={orgId} />
        </TabsContent>

        {featureFlags?.backups !== false && (
          <TabsContent value="backups" className="pt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Volume snapshots for services in this stack. Download or restore any backup.
            </p>
            {services.length > 0 ? (
              <div className="space-y-4">
                {services.map((service) => (
                  <div key={service.id} className="space-y-2">
                    <h3 className="text-sm font-medium">{service.displayName}</h3>
                    <AppBackupHistory orgId={orgId} appId={service.id} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No services in this stack yet.</p>
            )}
          </TabsContent>
        )}

        <TabsContent value="compose" className="pt-4">
          <ComposeEditor app={app} orgId={orgId} />
        </TabsContent>
      </Tabs>

      <ConfirmDeleteDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop stack"
        description={`Are you sure you want to stop all services in "${app.displayName}"?`}
        confirmLabel="Stop"
        onConfirm={handleStop}
      />

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete app"
        description={`Are you sure you want to delete "${app.displayName}"? This will stop all services and remove all associated data. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        loading={deleting}
      />

      {app.composeContent && (
        <ComposeReview
          open={showComposeReview}
          onOpenChange={setShowComposeReview}
          composeContent={app.composeContent}
          orgId={orgId}
          appId={app.id}
          onProceed={deploy.handleDeploy}
        />
      )}
    </div>
  );
}
