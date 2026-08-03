"use client";

import { Fragment, useState, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
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
  AlertTriangle,
  Check,
  Play,
  ScrollText,
  Undo2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { LogViewer } from "@/components/log-viewer";
import { EnvEditor } from "@/components/env-editor";
import { AppMetrics } from "./app-metrics";
import { AppBackupHistory } from "@/components/backups/app-backup-history";
import { StatusIndicator, Uptime } from "@/components/app-status";
import { AppRow } from "@/components/app-row";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { SPARKLINE_POINTS } from "@/components/app-metrics-card";
import { readingLabel, statusRank } from "@/lib/ui/app-row";
import type { ContainerPoint } from "@/lib/metrics/types";
import { formatBytes, formatCores } from "@/lib/metrics/format";
import { AppDeployPanel } from "./app-deploy-panel";
import { AppNetworking } from "./app-networking";
import { AppSecurity } from "./app-security";
import { AppErrors } from "./app-errors";
import { AppStability } from "./app-stability";
import type { Incident } from "@/lib/ui/stability";
import { CronManager } from "./app-cron";
import { AppDebug } from "./app-debug";
import { AppSettingsPanel } from "./app-settings-panel";
import { VolumesPanel } from "@/components/volumes-panel";
import { useDeploy } from "./hooks/use-deploy";
import { useCancelDeploy, useSlotStatus } from "./hooks/use-app-actions";
import { appActionMenu, type AppAction, type AppActionItem } from "@/lib/ui/app-actions";
import { systemManagedRefusal } from "@/lib/api/system-managed";
import { AppUpdatesPanel, useImageUpdates } from "./app-updates";
import { pendingImageChange, type PendingImage } from "@/lib/docker/image-updates/pending";
import { AppHeader } from "./app-header";
import { SectionNav, type SectionGroup } from "@/components/section-nav";
import { isOrgAdmin } from "@/lib/auth/permissions";
import { useAppEvents } from "@/hooks/use-app-events";
import { isRefreshEvent } from "@/lib/bus/refresh";
import type { BusEvent } from "@/lib/bus/events";
import type { App, ChildApp, Tag } from "./types";
import type { FeatureFlags } from "@/lib/config/features";
import { ComposeReview } from "@/components/compose-review";
import { SystemBadge } from "@/components/system-badge";
import { statusDotColor } from "@/lib/ui/status-colors";
import { crashSummary, extractDeployError } from "@/lib/ui/deploy-error";
import { currentStageLabel } from "@/lib/ui/deploy-stage";
import { rollupHealth } from "@/lib/ui/health-rollup";
import { tabPanelSurface } from "@/lib/ui/tab-panel";
import { cn } from "@/lib/utils";

const AppTerminal = dynamic(
  () => import("./app-terminal").then((m) => m.AppTerminal),
  { ssr: false },
);

// ---------------------------------------------------------------------------
// Service rows for the Services tab
// ---------------------------------------------------------------------------

/** The tag half of an image ref, or null when the image is untagged. */
function imageTag(imageName: string | null): string | null {
  if (!imageName) return null;
  const slash = imageName.lastIndexOf("/");
  const colon = imageName.lastIndexOf(":");
  return colon > slash ? imageName.slice(colon + 1) : null;
}

// Repo de-emphasized, tag as a discrete badge. The badge carries
// data-slot="image-tag" so the image update checker can annotate it.
// Labeled because compose can pin a different tag than the one deployed.
function ImageRef({ imageName }: { imageName: string }) {
  const tag = imageTag(imageName);
  const repo = tag ? imageName.slice(0, imageName.lastIndexOf(":")) : imageName;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="type-label shrink-0 text-muted-foreground/50">Deployed</span>
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

// What compose pins for this service, when the last deploy did not run it.
function PendingImageRef({ pending }: { pending: PendingImage }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="type-label shrink-0 text-status-warning">Available</span>
      {pending.repo && (
        <span className="truncate font-mono text-xs text-muted-foreground/60">{pending.repo}</span>
      )}
      <span className="shrink-0 rounded border border-status-warning/40 bg-status-warning-muted px-1.5 py-px font-mono text-[11px] leading-4 text-status-warning">
        {pending.tag}
      </span>
    </span>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-foreground/90">{children}</dd>
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
// metrics come from the parent stream's container breakdown, narrowed by
// compose service. Containers with no service label fall back to the name.
function matchServiceContainers(containers: ContainerPoint[], service: ChildApp): ContainerPoint[] {
  if (service.composeService) {
    const labeled = containers.filter((c) => c.composeService === service.composeService);
    if (labeled.length > 0) return labeled;
  }

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

// A service has no compose project of its own: restart names it inside the
// parent's, and everything else on the stack belongs to the parent.
function ServiceMenu({ service, orgId }: { service: ChildApp; orgId: string }) {
  const router = useRouter();
  const [restarting, setRestarting] = useState(false);

  async function handleRestart() {
    setRestarting(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${service.id}/restart`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) toast.success(`Restarted ${service.displayName}`);
      else toast.error(data.error || "Restart failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restart failed");
    } finally {
      setRestarting(false);
    }
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Actions for ${service.displayName}`}
          onClick={(e) => e.stopPropagation()}
        >
          <EllipsisVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem disabled={restarting} onClick={handleRestart}>
          <RotateCcw className="mr-2 size-4" />
          Restart
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/apps/${service.name}/logs`}>
            <ScrollText className="mr-2 size-4" />
            View logs
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The context a service row's dot, tag column and icon strip encode, spelled out. */
function ServiceRowCard({
  service,
  stats,
  pending,
}: {
  service: ChildApp;
  stats?: { cpuPercent: number; memoryUsage: number };
  pending?: PendingImage | null;
}) {
  const primaryDomain = service.domains.find((d) => d.isPrimary) || service.domains[0];
  const running = service.status === "active";
  const ports = formatPorts(service);

  return (
    <div className="w-72 space-y-2.5 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-medium text-foreground">{service.displayName}</span>
        <StatusIndicator
          status={service.status}
          needsRedeploy={!!service.needsRedeploy || !!pending}
        />
      </div>

      <div className="space-y-1 border-t pt-2">
        {service.imageName && <ImageRef imageName={service.imageName} />}
        {pending && <PendingImageRef pending={pending} />}
      </div>

      <dl className="space-y-1 border-t pt-2">
        <Detail label="Service">{service.composeService ?? service.name}</Detail>
        {running && (
          <Detail label="Usage">
            {readingLabel(stats?.cpuPercent, formatCores)} ·{" "}
            {readingLabel(stats?.memoryUsage, formatBytes)}
          </Detail>
        )}
        {running && service.containerStartedAt && (
          <Detail label="Uptime">
            <Uptime since={service.containerStartedAt} />
          </Detail>
        )}
        {ports && <Detail label="Ports">{ports}</Detail>}
        {primaryDomain && <Detail label="Domain">{primaryDomain.domain}</Detail>}
        {service.isShared && (
          <Detail label="Shared">A deploy leaves this service running</Detail>
        )}
      </dl>
    </div>
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
  // Compose pins, from the same source the Updates tab reads.
  const { data: updates } = useImageUpdates(orgId, appId);
  const pinned = useMemo(
    () => new Map((updates?.services ?? []).map((entry) => [entry.service, entry.image])),
    [updates],
  );

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

  // One line per service, problems first. The image tag takes the tag column,
  // and everything the card carried moves to the hover card.
  return (
    <div className="@container squircle rounded-lg bg-card p-1.5 shadow-card dark:border">
      {[...services]
        .sort(
          (x, y) =>
            statusRank(x.status) - statusRank(y.status) ||
            x.displayName.localeCompare(y.displayName),
        )
        .map((service) => {
          const pending = pendingImageChange(
            service.imageName,
            pinned.get(service.composeService ?? null) ?? null,
          );
          const tags = [imageTag(service.imageName), service.isShared ? "shared" : null].filter(
            (t): t is string => !!t,
          );
          return (
            <Tooltip key={service.id}>
              <TooltipTrigger asChild>
                <AppRow
                  app={{ ...service, tags }}
                  href={`/apps/${service.name}`}
                  series={histories.get(service.id)}
                  updateCount={pending ? 1 : 0}
                  trailing={<ServiceMenu service={service} orgId={orgId} />}
                />
              </TooltipTrigger>
              <TooltipContent
                side="right"
                align="start"
                sideOffset={6}
                className="bg-popover text-popover-foreground border shadow-card-hover px-3 py-2.5 [&>span]:hidden"
              >
                <ServiceRowCard
                  service={service}
                  stats={stats.get(service.id)}
                  pending={pending}
                />
              </TooltipContent>
            </Tooltip>
          );
        })}
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
// Per-service tabs — one service at a time, picked from a selector
// ---------------------------------------------------------------------------

// For concepts that only exist per container. Aggregating them across a stack
// would misattribute the result to services it did not come from.
function PerService({
  services,
  emptyMessage,
  className = "space-y-4",
  children,
}: {
  services: ChildApp[];
  emptyMessage: string;
  className?: string;
  children: (service: ChildApp) => React.ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string>(services[0]?.id || "");
  const selected = services.find((s) => s.id === selectedId) || services[0];

  if (!selected) {
    return (
      <div className="squircle lining flex flex-col items-center justify-center gap-4 rounded-lg border bg-card p-12">
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={className}>
      <ServiceSelector services={services} selectedId={selectedId} onSelect={setSelectedId} />
      {children(selected)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Networking tab — stack domains, plus where each service's own domains live
// ---------------------------------------------------------------------------

function ComposeNetworking({
  app,
  services,
  orgId,
  activeTab,
  initialSubView,
}: {
  app: App;
  services: ChildApp[];
  orgId: string;
  activeTab: string;
  initialSubView?: string;
}) {
  const serviceDomains = services.flatMap((service) =>
    service.domains.map((d) => ({ service, domain: d.domain })),
  );

  return (
    <div className="space-y-8">
      <AppNetworking
        domains={app.domains}
        exposedPorts={null}
        containerPort={app.containerPort}
        appId={app.id}
        appName={app.name}
        orgId={orgId}
        activeTab={activeTab}
        initialSubView={initialSubView}
        showPorts={false}
      />

      {serviceDomains.length > 0 && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Service domains</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pinned to one service. Open the service to edit its domains and ports.
            </p>
          </div>
          <div className="space-y-2">
            {serviceDomains.map(({ service, domain }) => (
              <Link
                key={`${service.id}-${domain}`}
                href={`/apps/${service.name}/networking`}
                className="squircle flex items-center justify-between gap-4 rounded-lg border bg-background-deep p-4 transition-colors hover:bg-accent"
              >
                <span className="truncate font-mono text-sm font-medium">{domain}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {service.displayName}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security tab — stack scan, plus where each service's own scan lives
// ---------------------------------------------------------------------------

// A scan checks one app's own domain and ports, so services holding their own
// domain are scanned on their own page rather than by the stack's scan.
function ComposeSecurity({
  app,
  services,
  orgId,
}: {
  app: App;
  services: ChildApp[];
  orgId: string;
}) {
  const scannedElsewhere = services.filter((s) => s.domains.length > 0);

  return (
    <div className="space-y-8">
      <AppSecurity appId={app.id} orgId={orgId} />

      {scannedElsewhere.length > 0 && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">Service scans</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              This scan covers the stack&apos;s own domain and ports. Services with their own domain
              are scanned separately.
            </p>
          </div>
          <div className="space-y-2">
            {scannedElsewhere.map((service) => (
              <Link
                key={service.id}
                href={`/apps/${service.name}/security`}
                className="squircle flex items-center justify-between gap-4 rounded-lg border bg-background-deep p-4 transition-colors hover:bg-accent"
              >
                <span className="truncate text-sm font-medium">{service.displayName}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {(service.domains.find((d) => d.isPrimary) ?? service.domains[0]).domain}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
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
      <EmptyState
        icon={FileCode2}
        title="No compose file stored"
        body="Deploy from a git repo to sync the compose file, or paste one below."
        action={
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Paste compose file
          </Button>
        }
      />
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
  initialSubView,
  featureFlags,
  allTags = [],
  siblings = [],
  stabilityIncidents = [],
  allParentApps = [],
}: {
  app: App & { childApps: NonNullable<App["childApps"]> };
  orgId: string;
  userRole: string;
  initialTab: string;
  initialSubView?: string;
  featureFlags: FeatureFlags;
  allTags?: Tag[];
  siblings?: { id: string; name: string; displayName: string; status: string; dependsOn: string[] | null }[];
  /** Durable stability history, newest first. */
  stabilityIncidents?: Incident[];
  allParentApps?: { id: string; name: string; color: string }[];
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

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

  // Same endpoint as Restart: compose restarts stopped services back up.
  const handleStart = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/restart`, { method: "POST" });
      const data = await res.json();
      if (data.success) toast.success("Stack started");
      else toast.error(data.error || "Start failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Start failed");
    }
    router.refresh();
  }, [orgId, app.id, router]);

  const handleRecreate = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/recreate`, { method: "POST" });
      const data = await res.json();
      data.success ? toast.success("Stack recreated") : toast.error(data.error || "Recreate failed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Recreate failed");
    }
    router.refresh();
  }, [orgId, app.id, router]);

  const { cancelling, cancelDeploy } = useCancelDeploy(orgId, app.id);
  const slotStatus = useSlotStatus(orgId, app.id, { refreshKey: app.status });

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

  // Image each service last deployed, for the Updates tab to compare against.
  const deployedImages = useMemo(
    () => Object.fromEntries(services.map((s) => [s.composeService ?? "", s.imageName])),
    [services],
  );

  const setActiveTabAndUrl = useCallback(
    (tab: string) => {
      setActiveTab(tab);
      const path =
        tab === "services" ? `/apps/${app.name}` : `/apps/${app.name}/${tab}`;
      window.history.replaceState({}, "", path);
    },
    [app.name],
  );

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

  // Set when the API would 403 the stop, so the menu offers it disabled with the reason.
  const stopRefusal = systemManagedRefusal(app, "stop");

  // Newest success other than the one serving — what a rollback would restore.
  const rollbackTargetId =
    app.deployments.filter((d) => d.status === "success")[1]?.id ?? null;

  const actions = appActionMenu({
    status: app.status,
    isChildService: false,
    deploying: deploy.deploying,
    standbyAvailable: !!slotStatus?.standbyAvailable,
    hasDeployed: totalDeployments > 0,
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
      return {
        className: app.needsRedeploy
          ? "bg-status-warning-muted text-status-warning hover:ring-1 hover:ring-inset hover:ring-status-warning/40"
          : "bg-status-success-muted text-status-success hover:ring-1 hover:ring-inset hover:ring-status-success/40",
        content: app.needsRedeploy ? (
          <><RotateCcw className="mr-1.5 size-3.5" />Restart needed</>
        ) : (
          <><span className="mr-1.5 size-2 rounded-full bg-status-success animate-pulse" />Running</>
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
        content: <><AlertTriangle className="mr-1.5 size-3.5" />No containers</>,
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
    setActiveTabAndUrl("deployments");
    deploy.handleRollbackPreview(rollbackTargetId);
  }

  const ACTION_LABEL: Record<AppAction, { icon: LucideIcon; label: string }> = {
    "cancel-deploy": { icon: X, label: "Cancel deploy" },
    deploy: { icon: Rocket, label: app.status === "error" ? "Retry deploy" : "Redeploy stack" },
    start: { icon: Play, label: "Start stack" },
    restart: { icon: RotateCcw, label: "Restart stack" },
    recreate: { icon: RefreshCw, label: "Recreate stack" },
    "instant-rollback": { icon: Zap, label: "Roll back to standby" },
    rollback: { icon: Undo2, label: "Roll back to a previous deploy" },
    logs: { icon: ScrollText, label: "View logs" },
    stop: { icon: Square, label: "Stop stack" },
  };

  const ACTION_HANDLER: Record<AppAction, () => void> = {
    "cancel-deploy": () => { void cancelDeploy(); },
    deploy: handleDeployClick,
    start: handleStart,
    restart: handleRestart,
    recreate: handleRecreate,
    "instant-rollback": () => setRollbackOpen(true),
    rollback: handleRollback,
    logs: () => setActiveTabAndUrl("logs"),
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
      <span className="sr-only" aria-live="assertive" aria-atomic="true">
        {deploy.deployAnnouncement}
      </span>

      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {/* One action for a never-deployed stack is a button, not a menu. */}
            {actions.length === 1 && actions[0].action === "deploy" ? (
              <Button size="sm" disabled={deploy.deploying} onClick={handleDeployClick}>
                {deploy.deploying ? (
                  <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
                ) : (
                  <><Rocket className="mr-1.5 size-4" />Deploy stack</>
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <span className={`size-2 rounded-full ${statusDotColor(app.status)}`} />
                  {app.displayName}
                  <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem disabled>
                  <span className={`mr-2 size-2 rounded-full ${statusDotColor(app.status)}`} />
                  {app.displayName}
                  <Check className="ml-auto size-3.5" />
                </DropdownMenuItem>
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
          <h1 className="type-h1">{app.displayName}</h1>
        )}
        {app.isSystemManaged && <SystemBadge />}
      </PageToolbar>

      {/* Failure detail — the stack's own deploy log when it failed, otherwise
          the services that are actually down, each linked to its page. */}
      {app.status === "error" && (() => {
        const failedDeploy = app.deployments.find((d) => d.status === "failed");
        const crash = crashSummary(services);
        const message =
          extractDeployError(failedDeploy?.log) ||
          crash?.message ||
          "Stack crashed — check the service logs for details";
        return (
          <div className="flex items-start gap-2 rounded-lg bg-status-error-muted px-4 py-2.5 text-sm text-status-error">
            <X className="size-4 shrink-0 mt-0.5" />
            <span
              className="flex-1 line-clamp-3 break-words font-mono text-xs leading-relaxed"
              title={message}
            >
              {message}
            </span>
            <div className="flex items-center gap-2 shrink-0 mt-0.5">
              {crash?.crashed.slice(0, 2).map((service) => (
                <Link
                  key={service.id}
                  href={`/apps/${service.name}/logs`}
                  className="text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
                >
                  {service.displayName}
                </Link>
              ))}
              {failedDeploy && (
                <button
                  type="button"
                  onClick={() => { setActiveTabAndUrl("deployments"); deploy.setViewingLogId(failedDeploy.id); }}
                  className="text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
                >
                  View log
                </button>
              )}
              <button
                type="button"
                disabled={deploy.deploying}
                onClick={handleDeployClick}
                className="text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
              >
                Retry
              </button>
            </div>
          </div>
        );
      })()}

      {/* Same shell as a single-service app: identity header + section rail.
          A stack is an app page identified as a stack, not a different page. */}
      <AppHeader
        app={app}
        orgId={orgId}
        isChildService={false}
        deployments={app.deployments}
        allTags={allTags}
        siblings={siblings}
        onNavigate={setActiveTabAndUrl}
        stack={rollupHealth(services)}
        deployStage={currentStageLabel(deploy.deployStages)}
        stabilityIncidents={stabilityIncidents}
      />


      {/* Sections — vertical nav rail on lg+, scroll strip below */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTabAndUrl}
        orientation="vertical"
        className="flex-col gap-6 lg:flex-row lg:gap-8"
      >
        <aside className="lg:w-48 lg:shrink-0">
          <div className="lg:sticky lg:top-24">
            <SectionNav
              groups={[
                {
                  items: [
                    { value: "services", label: "Services", count: services.length },
                    { value: "deployments", label: "Deployments", count: totalDeployments },
                    { value: "updates", label: "Updates" },
                  ],
                },
                {
                  label: "Configure",
                  items: [
                    { value: "variables", label: "Variables", count: app.envVars.length },
                    { value: "networking", label: "Networking" },
                    { value: "compose", label: "Compose" },
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
            onDeploy={handleDeployClick}
            deploying={deploy.deploying}
            deployed={deployedImages}
          />
        </TabsContent>

        <TabsContent value="services">
          {services.length === 0 ? (
            <div className="squircle lining flex flex-col items-center justify-center gap-4 rounded-lg border bg-card p-12">
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
            onDeploy={handleDeployClick}
            deployActionLabel="Deploy stack"
          />
        </TabsContent>

        <TabsContent value="variables" className={cn(tabPanelSurface, "space-y-4")}>
          <EnvEditor
            appId={app.id}
            appName={app.name}
            orgId={orgId}
          />
        </TabsContent>

        <TabsContent value="networking" className={cn(tabPanelSurface, "space-y-4")}>
          <ComposeNetworking
            app={app}
            services={services}
            orgId={orgId}
            activeTab={activeTab}
            initialSubView={activeTab === "networking" ? initialSubView : undefined}
          />
        </TabsContent>

        <TabsContent value="settings" className={tabPanelSurface}>
          <AppSettingsPanel
            app={app}
            orgId={orgId}
            userRole={userRole}
            allParentApps={allParentApps}
            handleDeploy={handleDeployClick}
            isComposeParent
          />
        </TabsContent>

        <TabsContent value="stability">
          <AppStability orgId={orgId} app={app} incidents={stabilityIncidents} />
        </TabsContent>

        {featureFlags?.logging !== false && (
          <TabsContent value="logs">
            <PerService
              services={services}
              emptyMessage="No services to show logs for."
              className="space-y-3"
            >
              {(service) => (
                <LogViewer
                  key={`logs-${service.id}`}
                  streamUrl={`/api/v1/organizations/${orgId}/apps/${service.id}/logs/stream`}
                  initialLevels={initialSubView === "errors" ? ["error"] : undefined}
                />
              )}
            </PerService>
          </TabsContent>
        )}

        {featureFlags?.metrics !== false && (
          <TabsContent value="metrics">
            <PerService services={services} emptyMessage="No services to show metrics for.">
              {(service) => (
                <AppMetrics key={`metrics-${service.id}`} orgId={orgId} appId={service.id} />
              )}
            </PerService>
          </TabsContent>
        )}

        <TabsContent value="errors" className={cn(tabPanelSurface, "space-y-4")}>
          <AppErrors appName={app.name} appId={app.id} orgId={orgId} />
        </TabsContent>

        {featureFlags?.cron !== false && (
          <TabsContent value="cron" className={cn(tabPanelSurface, "space-y-4")}>
            <p className="text-sm text-muted-foreground">
              Scheduled commands run inside the service you pick here, not across the stack.
            </p>
            <PerService services={services} emptyMessage="No services to schedule jobs for.">
              {(service) => (
                <CronManager key={`cron-${service.id}`} orgId={orgId} appId={service.id} />
              )}
            </PerService>
          </TabsContent>
        )}

        {featureFlags?.backups !== false && (
          <TabsContent value="backups" className={cn(tabPanelSurface, "space-y-4")}>
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

        <TabsContent value="security" className={tabPanelSurface}>
          <ComposeSecurity app={app} services={services} orgId={orgId} />
        </TabsContent>

        <TabsContent value="volumes" className={tabPanelSurface}>
          <VolumesPanel appId={app.id} orgId={orgId} />
        </TabsContent>

        {featureFlags?.terminal !== false && (
          <TabsContent value="terminal" className={cn(tabPanelSurface, "space-y-4")}>
            <p className="text-sm text-muted-foreground">
              Interactive shell in one of the stack&apos;s containers. Filesystem changes are lost on redeploy unless written to a persistent volume.
            </p>
            <AppTerminal appId={app.id} orgId={orgId} />
          </TabsContent>
        )}

        {isOrgAdmin(userRole) && (
          <TabsContent value="debug" className={tabPanelSurface}>
            <AppDebug orgId={orgId} appId={app.id} />
          </TabsContent>
        )}

        <TabsContent value="compose" className={tabPanelSurface}>
          <ComposeEditor app={app} orgId={orgId} />
        </TabsContent>

        </div>
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
