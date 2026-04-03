"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Rocket,
  Loader2,
  RotateCcw,
  ChevronDown,
  FileCode2,
  Container,
  Trash2,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { LogViewer } from "@/components/log-viewer";
import { EnvEditor } from "@/components/env-editor";
import { AppMetrics } from "./app-metrics";
import { AppBackupHistory } from "@/components/backups/app-backup-history";
import { statusDotColor } from "@/lib/ui/status-colors";
import { AppDeployPanel } from "./app-deploy-panel";
import { useDeploy } from "./hooks/use-deploy";
import { isAdmin } from "@/lib/auth/permissions";
import type { App, ChildApp } from "./types";
import type { FeatureFlags } from "@/lib/config/features";
import { ComposeReview } from "@/components/compose-review";

// ---------------------------------------------------------------------------
// Service card for the Services tab
// ---------------------------------------------------------------------------

function ServiceCard({ service }: { service: ChildApp }) {
  const primaryDomain = service.domains.find((d) => d.isPrimary) || service.domains[0];
  return (
    <Link
      href={`/apps/${service.name}`}
      className="squircle relative flex flex-col rounded-lg border bg-card p-4 transition-all duration-200 hover:bg-accent/50 overflow-hidden cursor-pointer"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span aria-hidden="true" className={`size-2 rounded-full shrink-0 ${statusDotColor(service.status)}`} />
        <h3 className="text-sm font-semibold truncate">{service.displayName}</h3>
      </div>
      {service.composeService && (
        <p className="text-xs text-muted-foreground/60 font-mono mt-1 truncate">
          {service.composeService}
        </p>
      )}
      {primaryDomain && (
        <p className="text-xs text-muted-foreground font-mono mt-1 truncate">
          {primaryDomain.domain}
        </p>
      )}
      {service.imageName && !primaryDomain && (
        <p className="text-xs text-muted-foreground/60 font-mono mt-0.5 truncate">
          {service.imageName}
        </p>
      )}
    </Link>
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

  const canDelete = isAdmin(userRole);

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
              className="text-2xl font-semibold tracking-tight text-muted-foreground hover:text-foreground transition-colors"
            >
              {app.project.displayName}
            </Link>
            <span className="text-muted-foreground/40 text-xl">›</span>
            <h1 className="text-2xl font-semibold tracking-tight">{app.displayName}</h1>
          </>
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight">{app.displayName}</h1>
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
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {services.map((service) => (
                <ServiceCard key={service.id} service={service} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="deployments">
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
