"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Globe } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { detectProjectIcon } from "@/lib/ui/project-icon";
import {
  type AppMetrics,
  type MetricKey,
  type MetricsHistory,
  EMPTY_HISTORY,
  Sparkline,
  MetricsLine,
  useAppMetrics,
} from "@/components/app-metrics-card";

type Tag = { id: string; name: string; color: string };

type AppWithRelations = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: string;
  deployType: string;
  imageName: string | null;
  gitUrl: string | null;
  projectId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: { id: string; status: string; startedAt: Date; finishedAt: Date | null }[];
  appTags: { tag: Tag }[];
  project: { id: string; name: string; displayName: string; color: string | null } | null;
};

type AppGridProps = {
  apps: AppWithRelations[];
  allTags: Tag[];
  orgId: string;
};


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusDotColor(status: string) {
  return status === "active" ? "bg-status-success"
    : status === "error" ? "bg-status-error"
    : status === "deploying" ? "bg-status-info"
    : "bg-status-neutral";
}

function formatUptime(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Uptime({ since }: { since: Date }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(formatUptime(since));
    const interval = setInterval(() => setText(formatUptime(since)), 1000);
    return () => clearInterval(interval);
  }, [since]);
  if (!text) return null;
  return <span className="tabular-nums">{text}</span>;
}

/** Get the icon for an app */
function getAppIcon(app: { imageName: string | null; gitUrl: string | null; deployType: string; name: string; displayName: string }): string | null {
  return detectProjectIcon(app);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AppIcon({ app }: { app: AppWithRelations }) {
  const color = app.project?.color || "#6366f1";
  const icon = getAppIcon(app);

  if (!icon) {
    return (
      <div
        className="size-12 shrink-0 rounded-md flex items-center justify-center"
        style={{ backgroundColor: `${color}20` }}
      >
        <span className="size-3 rounded-full" style={{ backgroundColor: color }} />
      </div>
    );
  }

  return (
    <div
      className="size-12 shrink-0 rounded-md flex items-center justify-center"
      style={{ backgroundColor: `${color}10` }}
    >
      <img src={icon} alt="" className="size-8 opacity-70" />
    </div>
  );
}

function StatusIndicator({
  status,
  finishedAt,
}: {
  status: "running" | "error" | "deploying" | "stopped";
  finishedAt?: Date | null;
}) {
  switch (status) {
    case "running":
      return (
        <span className="flex items-center gap-1.5 text-sm text-status-success shrink-0">
          <span className="size-2 rounded-full bg-status-success animate-pulse" />
          {finishedAt ? <Uptime since={finishedAt} /> : "Running"}
        </span>
      );
    case "error":
      return <span className="text-sm text-status-error shrink-0">Error</span>;
    case "deploying":
      return <span className="text-sm text-status-info animate-pulse shrink-0">Deploying</span>;
    default:
      return <span className="text-sm text-status-neutral shrink-0">Stopped</span>;
  }
}


function EndpointsPopover({ app }: { app: AppWithRelations }) {
  const endpoints: { label: string; domain: string }[] = [];

  for (const d of app.domains) {
    endpoints.push({ label: app.displayName, domain: d.domain });
  }

  if (endpoints.length === 0) return null;

  if (endpoints.length === 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={`https://${endpoints[0].domain}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          >
            <Globe className="size-3.5" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="bottom">{endpoints[0].domain}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.preventDefault()}
          className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
        >
          <Globe className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-0.5">
          {endpoints.map((ep) => (
            <a
              key={ep.domain}
              href={`https://${ep.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
            >
              <span className="truncate text-muted-foreground">{ep.label}</span>
              <span className="truncate font-mono text-xs text-foreground">{ep.domain}</span>
            </a>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}


function ProjectEndpoints({ projectApps }: { projectApps: AppWithRelations[] }) {
  const endpoints: { label: string; domain: string }[] = [];
  for (const a of projectApps) {
    for (const d of a.domains) {
      endpoints.push({ label: a.displayName, domain: d.domain });
    }
  }

  if (endpoints.length === 0) return null;

  if (endpoints.length === 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={`https://${endpoints[0].domain}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          >
            <Globe className="size-3.5" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="bottom">{endpoints[0].domain}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.preventDefault()}
          className="shrink-0 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
        >
          <Globe className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-0.5">
          {endpoints.map((ep) => (
            <a
              key={ep.domain}
              href={`https://${ep.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
            >
              <span className="truncate text-muted-foreground">{ep.label}</span>
              <span className="truncate font-mono text-xs text-foreground">{ep.domain}</span>
            </a>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// ProjectCard — groups multiple apps under one project
// ---------------------------------------------------------------------------

function ProjectCard({
  project,
  projectApps,
  metrics,
  history,
  historyTick,
}: {
  project: NonNullable<AppWithRelations["project"]>;
  projectApps: AppWithRelations[];
  metrics: Map<string, AppMetrics>;
  history: Map<string, MetricsHistory>;
  historyTick: number;
}) {
  const color = project.color || "#6366f1";

  // Aggregate status from all apps
  const allActive = projectApps.every((a) => a.status === "active");
  const anyError = projectApps.some((a) => a.status === "error");
  const anyDeploying = projectApps.some((a) => a.status === "deploying");
  const status = allActive ? "running" : anyError ? "error" : anyDeploying ? "deploying" : "stopped";

  // Aggregate CPU for sparkline from all apps
  const aggregatedCpu = useMemo(() => {
    const maxLen = Math.max(...projectApps.map((a) => (history.get(a.id)?.cpu || []).length), 0);
    if (maxLen < 2) return [];
    const result: number[] = [];
    for (let i = 0; i < maxLen; i++) {
      let sum = 0;
      for (const a of projectApps) {
        const cpu = history.get(a.id)?.cpu || [];
        sum += cpu[i] || 0;
      }
      result.push(sum);
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectApps, historyTick]);

  // Collect unique icons
  const icons = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const a of projectApps) {
      const icon = getAppIcon(a);
      if (icon && !seen.has(icon)) {
        seen.add(icon);
        result.push(icon);
      }
      if (result.length >= 4) break;
    }
    return result;
  }, [projectApps]);

  return (
    <Link
      href={`/projects/${project.name}`}
      className="squircle relative flex flex-col rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 overflow-hidden"
    >
      {aggregatedCpu.length >= 1 && (
        <Sparkline
          data={aggregatedCpu}
          className="absolute inset-0 w-full h-full text-foreground pointer-events-none"
        />
      )}

      <div className="relative flex gap-4">
        {/* Icon grid */}
        {icons.length === 0 ? (
          <div className="size-12 shrink-0 rounded-md flex items-center justify-center" style={{ backgroundColor: `${color}20` }}>
            <span className="size-3 rounded-full" style={{ backgroundColor: color }} />
          </div>
        ) : icons.length === 1 ? (
          <div className="size-12 shrink-0 rounded-md flex items-center justify-center" style={{ backgroundColor: `${color}10` }}>
            <img src={icons[0]} alt="" className="size-8 opacity-70" />
          </div>
        ) : (
          <div className="size-12 shrink-0 rounded-md grid grid-cols-2 gap-0.5 p-1" style={{ backgroundColor: `${color}10` }}>
            {icons.slice(0, 4).map((icon, i) => (
              <img key={i} src={icon} alt="" className="size-full opacity-60" />
            ))}
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-base font-semibold truncate">{project.displayName}</h3>
              <ProjectEndpoints projectApps={projectApps} />
            </div>
            <StatusIndicator
              status={status}
              finishedAt={allActive ? (() => {
                // Latest deploy finish across all apps
                let latest: Date | null = null;
                for (const a of projectApps) {
                  const f = a.deployments[0]?.finishedAt;
                  if (f) {
                    const d = new Date(f);
                    if (!latest || d > latest) latest = d;
                  }
                }
                return latest;
              })() : undefined}
            />
          </div>
          {/* Aggregated metrics */}
          {(() => {
            const agg: AppMetrics = { cpuPercent: 0, memoryUsage: 0, memoryLimit: 0, diskUsage: 0, networkRx: 0, networkTx: 0 };
            for (const a of projectApps) {
              const m = metrics.get(a.id);
              if (m) {
                agg.cpuPercent += m.cpuPercent;
                agg.memoryUsage += m.memoryUsage;
                agg.memoryLimit = Math.max(agg.memoryLimit, m.memoryLimit);
                agg.diskUsage += m.diskUsage;
                agg.networkRx += m.networkRx;
                agg.networkTx += m.networkTx;
              }
            }
            return (agg.cpuPercent > 0 || agg.memoryUsage > 0)
              ? <MetricsLine metrics={agg} onHover={() => {}} />
              : null;
          })()}
        </div>
      </div>

      {/* App chips */}
      <div className="relative flex flex-wrap gap-1.5 mt-3 pt-3 border-t">
        {projectApps.map((a) => (
          <Link
            key={a.id}
            href={`/apps/${a.name}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium bg-background hover:bg-accent transition-colors"
          >
            <span className={`size-1.5 rounded-full ${statusDotColor(a.status)}`} />
            {a.displayName}
          </Link>
        ))}
      </div>
    </Link>
  );
}

function AppCard({
  app,
  metrics,
  history,
}: {
  app: AppWithRelations;
  metrics?: AppMetrics;
  history: MetricsHistory;
}) {
  const lastDeploy = app.deployments[0];
  const [hoveredMetric, setHoveredMetric] = useState<MetricKey | null>(null);

  const activeMetric = hoveredMetric || "cpu";

  return (
    <Link
      href={`/apps/${app.name}`}
      className="squircle relative flex flex-col rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 overflow-hidden"
    >
      {/* Background sparklines — crossfade on hover */}
      {(["cpu", "memory", "disk", "network"] as MetricKey[]).map((key) => {
        const data = history[key];
        if (data.length === 0) return null;
        return (
          <Sparkline
            key={key}
            data={data}
            className={`absolute inset-0 w-full h-full text-foreground pointer-events-none transition-opacity duration-300 ${
              activeMetric === key ? "opacity-100" : "opacity-0"
            }`}
          />
        );
      })}

      <div className="relative flex gap-4">
        <AppIcon app={app} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-base font-semibold truncate">
                {app.displayName}
              </h3>
              <EndpointsPopover app={app} />
            </div>
            <StatusIndicator
              status={
                app.status === "active" ? "running"
                  : app.status === "error" ? "error"
                  : app.status === "deploying" ? "deploying"
                  : "stopped"
              }
              finishedAt={lastDeploy?.finishedAt}
            />
          </div>
          {app.description && (
            <p className="text-sm text-muted-foreground mt-1 truncate">
              {app.description}
            </p>
          )}
          {!app.description && (
            <p className="text-sm text-muted-foreground/40 mt-1 truncate">
              {app.imageName ||
                app.gitUrl
                  ?.replace("https://github.com/", "")
                  .replace(".git", "") ||
                app.deployType}
            </p>
          )}
          {metrics && <MetricsLine metrics={metrics} onHover={setHoveredMetric} />}
          {app.appTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {app.appTags.map(({ tag }) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: `${tag.color}15`,
                    color: tag.color,
                  }}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

    </Link>
  );
}

// ---------------------------------------------------------------------------
// AppGrid
// ---------------------------------------------------------------------------

export function AppGrid({
  apps,
  allTags,
  orgId,
}: AppGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const { metrics, history, historyTick } = useAppMetrics(orgId);

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(interval);
  }, [router]);

  const filtered = useMemo(() => {
    let list = apps;
    if (activeTagIds.size > 0) {
      list = list.filter((p) => {
        const ids = new Set(p.appTags.map((pt) => pt.tag.id));
        for (const tagId of activeTagIds) if (!ids.has(tagId)) return false;
        return true;
      });
    }
    return list;
  }, [apps, activeTagIds]);

  // Group apps by project for rendering
  const { projectCards, standaloneApps } = useMemo(() => {
    const byProject = new Map<string, { project: NonNullable<AppWithRelations["project"]>; apps: AppWithRelations[] }>();
    const standalone: AppWithRelations[] = [];

    for (const app of filtered) {
      if (app.project) {
        const existing = byProject.get(app.project.id);
        if (existing) {
          existing.apps.push(app);
        } else {
          byProject.set(app.project.id, { project: app.project, apps: [app] });
        }
      } else {
        standalone.push(app);
      }
    }

    return { projectCards: Array.from(byProject.values()), standaloneApps: standalone };
  }, [filtered]);

  return (
    <div className="space-y-4">
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {allTags.map((tag) => {
            const on = activeTagIds.has(tag.id);
            return (
              <button
                key={tag.id}
                onClick={() =>
                  setActiveTagIds((prev) => {
                    const n = new Set(prev);
                    if (n.has(tag.id)) n.delete(tag.id);
                    else n.add(tag.id);
                    return n;
                  })
                }
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  on
                    ? "text-white"
                    : "border bg-background text-foreground hover:bg-accent"
                }`}
                style={
                  on
                    ? { backgroundColor: tag.color }
                    : { borderColor: `${tag.color}40` }
                }
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
              </button>
            );
          })}
          {activeTagIds.size > 0 && (
            <button
              onClick={() => setActiveTagIds(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projectCards.map(({ project, apps: projectApps }) => (
          <ProjectCard
            key={project.id}
            project={project}
            projectApps={projectApps}
            metrics={metrics}
            history={history}
            historyTick={historyTick}
          />
        ))}
        {standaloneApps.map((app) => (
          <AppCard
            key={app.id}
            app={app}
            metrics={metrics.get(app.id)}
            history={history.get(app.id) || EMPTY_HISTORY}
          />
        ))}
      </div>

      {filtered.length === 0 && apps.length > 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <p className="text-sm text-muted-foreground">
            No apps match the current filters.
          </p>
          <button
            onClick={() => setActiveTagIds(new Set())}
            className="text-sm text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
