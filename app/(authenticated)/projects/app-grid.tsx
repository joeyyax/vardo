"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Package, Search } from "lucide-react";
import { EndpointsPopover } from "@/components/endpoints-popover";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  filterApps,
  isSortKey,
  matchesProject,
  sortProjectCards,
  SORT_OPTIONS,
  type SortKey,
} from "@/lib/ui/app-filter";
import { RelativeTime } from "@/components/relative-time";
import { detectAppType } from "@/lib/ui/app-type";
import { uniformStatus } from "@/lib/ui/status-colors";
import { statusRank } from "@/lib/ui/app-row";
import { countNeedingAttention } from "@/lib/ui/conditions";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { AppRow } from "@/components/app-row";
import { AppRowCard } from "@/components/app-row-card";
import { type AppCondition } from "@/lib/docker/conditions";
import { StatusIndicator } from "@/components/app-status";
import { SystemBadge } from "@/components/system-badge";
import { useImageUpdates } from "./updates-banner";

import {
  type AppMetrics,
  type MetricsHistory,
  type MetricKey,
  MetricsBand,
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
  projectId: string;
  gpuEnabled: boolean | null;
  priority: "critical" | "standard" | "disposable" | null;
  status: string;
  containerStartedAt: Date | null;
  containerMemoryLimit: number | null;
  needsRedeploy: boolean | null;
  conditions: AppCondition[] | null;
  createdAt: Date;
  updatedAt: Date;
  domains: { domain: string; isPrimary: boolean | null }[];
  deployments: { id: string; status: string; startedAt: Date; finishedAt: Date | null }[];
  appTags: { tag: Tag }[];
  project: { id: string; name: string; displayName: string; color: string | null; isSystemManaged: boolean };
  childApps?: { id: string; displayName: string; status: string }[];
};

type EmptyProject = {
  id: string;
  name: string;
  displayName: string;
  color: string | null;
  isSystemManaged: boolean;
};

type AppGridProps = {
  apps: AppWithRelations[];
  allTags: Tag[];
  orgId: string;
  emptyProjects?: EmptyProject[];
};


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// ProjectCard — groups multiple apps under one project
// ---------------------------------------------------------------------------

function ProjectCard({
  project,
  projectApps,
  metrics,
  history,
  historyTick,
  updatesByApp,
}: {
  project: NonNullable<AppWithRelations["project"]>;
  projectApps: AppWithRelations[];
  metrics: Map<string, AppMetrics>;
  history: Map<string, MetricsHistory>;
  historyTick: number;
  updatesByApp: Map<string, number>;
}) {
  const color = "#a1a1aa"; // neutral zinc-400 — project color is unused

  // Aggregate status: healthy is quiet, deviation is loud. All-running shows a
  // muted count; crashes show a red count; a mix shows an honest count.
  const activeCount = projectApps.filter((a) => a.status === "active").length;
  const errorCount = projectApps.filter((a) => a.status === "error").length;
  const allActive = activeCount === projectApps.length;
  const partial = activeCount > 0 && !allActive;
  const anyMissing = projectApps.some((a) => a.status === "missing");
  const anyDeploying = projectApps.some((a) => a.status === "deploying");
  const idleStatus = anyMissing ? "missing" : anyDeploying ? "deploying" : "stopped";
  const attention = countNeedingAttention(projectApps);
  const attentionCount = attention.critical + attention.warning;

  const sharedStatus = uniformStatus(projectApps.map((a) => a.status));

  // Per-metric history summed across apps
  const aggregatedHistory = useMemo(() => {
    const result: Partial<MetricsHistory> = {};
    for (const key of ["cpu", "memory", "disk", "network"] as MetricKey[]) {
      const maxLen = Math.max(...projectApps.map((a) => (history.get(a.id)?.[key] || []).length), 0);
      if (maxLen < 2) continue;
      const series: number[] = [];
      for (let i = 0; i < maxLen; i++) {
        let sum = 0;
        for (const a of projectApps) {
          const s = history.get(a.id)?.[key] || [];
          sum += s[i] || 0;
        }
        series.push(sum);
      }
      result[key] = series;
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectApps, historyTick]);

  // Aggregated live metrics. The memory limit is the sum of per-app limits and
  // only honest when every running app has one — partial sums would understate
  // the ceiling.
  const { agg, memoryLimitTotal, anyMetrics } = useMemo(() => {
    const agg: AppMetrics = { cpuPercent: 0, memoryUsage: 0, memoryLimit: 0, diskUsage: 0, networkRx: 0, networkTx: 0 };
    let limitSum = 0;
    let allLimited = true;
    let anyMetrics = false;
    for (const a of projectApps) {
      const m = metrics.get(a.id);
      if (!m) {
        if (a.status === "active") allLimited = false;
        continue;
      }
      anyMetrics = true;
      agg.cpuPercent += m.cpuPercent;
      agg.memoryUsage += m.memoryUsage;
      agg.diskUsage += m.diskUsage;
      agg.networkRx += m.networkRx;
      agg.networkTx += m.networkTx;
      if (m.memoryLimit > 0) limitSum += m.memoryLimit;
      else allLimited = false;
    }
    return { agg, memoryLimitTotal: anyMetrics && allLimited ? limitSum : 0, anyMetrics };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectApps, metrics, historyTick]);

  // Most recent deployment across the project's apps.
  const lastDeploy = useMemo(() => {
    let latest: { status: string; startedAt: Date } | null = null;
    for (const a of projectApps) {
      const d = a.deployments[0];
      if (d && (!latest || new Date(d.startedAt) > new Date(latest.startedAt))) latest = d;
    }
    return latest;
  }, [projectApps]);

  const updateCount = projectApps.reduce((n, a) => n + (updatesByApp.get(a.id) ?? 0), 0);

  // Collect unique icons
  const icons = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const a of projectApps) {
      const icon = detectAppType(a).icon;
      if (icon && !seen.has(icon)) {
        seen.add(icon);
        result.push(icon);
      }
      if (result.length >= 4) break;
    }
    return result;
  }, [projectApps]);

  const isSystem = project.isSystemManaged;

  const deployFragment = lastDeploy && (
    lastDeploy.status === "failed" ? (
      <span className="text-status-error">
        Deploy failed <RelativeTime date={lastDeploy.startedAt} />
      </span>
    ) : lastDeploy.status === "running" || lastDeploy.status === "queued" ? (
      <span className="text-status-info">Deploying now</span>
    ) : (
      <span>Deployed <RelativeTime date={lastDeploy.startedAt} /></span>
    )
  );

  return (
    <div className="@container squircle relative flex flex-col rounded-lg bg-card shadow-card dark:border transition-shadow hover:shadow-card-hover overflow-hidden">
      {/* Whole-card click target; interactive children stack above it */}
      <Link
        href={`/projects/${project.name}`}
        className="absolute inset-0 z-0"
        aria-label={project.displayName}
      />
      {/* Raised panel: identity + aggregate state */}
      <div className="p-5">
        <div className="flex gap-4">
        {/* One icon — a collage of the same marks on every card is noise */}
        {icons.length === 0 ? (
          <div className="size-12 shrink-0 rounded-md flex items-center justify-center" style={{ backgroundColor: `${color}20` }}>
            <span className="size-3 rounded-full" style={{ backgroundColor: color }} />
          </div>
        ) : (
          <div className="size-12 shrink-0 rounded-md flex items-center justify-center" style={{ backgroundColor: `${color}10` }}>
            <img src={icons[0]} alt="" className="size-8 opacity-70" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          {/* Wraps rather than truncating: the title outranks the rollup beside it. */}
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-base font-semibold truncate">{project.displayName}</h3>
              {isSystem && <SystemBadge compact className="shrink-0" />}
              <span className="relative z-10">
                <EndpointsPopover endpoints={projectApps.flatMap((a) => a.domains.map((d) => ({ label: a.displayName, domain: d.domain })))} />
              </span>
            </div>
            {/* Reach and health are separate facts — an app can be running and
                crash-looping, and hiding either behind the other is what made
                this header read as less informative than the list below it. */}
            {projectApps.length === 0 ? (
              <span className="text-xs text-muted-foreground">Empty</span>
            ) : (
              <span className="flex shrink-0 items-center gap-2 text-sm">
                {errorCount > 0 ? (
                  <span className="flex items-center gap-1.5 text-status-error">
                    <span aria-hidden="true" className="size-2 rounded-full bg-status-error" />
                    {errorCount} crashed
                  </span>
                ) : partial ? (
                  <span className="flex items-center gap-1.5 text-status-warning">
                    <span aria-hidden="true" className="size-2 rounded-full bg-status-warning" />
                    {activeCount}/{projectApps.length} running
                  </span>
                ) : allActive ? (
                  projectApps.some((a) => !!a.needsRedeploy) ? (
                    <StatusIndicator status="running" needsRedeploy />
                  ) : (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-status-success" />
                      {projectApps.length} up
                    </span>
                  )
                ) : (
                  <StatusIndicator status={idleStatus} />
                )}
                {attentionCount > 0 && (
                  <span
                    className={`flex items-center gap-1.5 ${attention.critical > 0 ? "text-status-error" : "text-status-warning"}`}
                  >
                    {attentionCount} need{attentionCount === 1 ? "s" : ""} attention
                  </span>
                )}
              </span>
            )}
          </div>
          {/* What changed — deploy recency and pending updates */}
          {(deployFragment || updateCount > 0) && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {deployFragment}
              {deployFragment && updateCount > 0 && <span aria-hidden="true">·</span>}
              {updateCount > 0 && (
                <span className="flex items-center gap-1">
                  <Package className="size-3" aria-hidden="true" />
                  {updateCount} update{updateCount === 1 ? "" : "s"} available
                </span>
              )}
            </p>
          )}
        </div>
        </div>
      </div>

      {/* Recessed app list — rows sit on a lower surface, problems sort first */}
      <div className="flex-1 border-t bg-background-deep px-2.5 py-2">
        {projectApps.length === 0 ? (
          <Link
            href={`/apps/new?project=${project.id}`}
            className="relative z-10 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-card transition-colors cursor-pointer"
          >
            <Plus className="size-3" />
            Add app
          </Link>
        ) : (
          /* One app per row: two columns halved the width available to a name,
             its status word and its badges, which is what truncated first. */
          <div className="@container grid content-start">
            {[...projectApps]
              .sort(
                (x, y) =>
                  statusRank(x.status) - statusRank(y.status) ||
                  Number(y.priority === "critical") - Number(x.priority === "critical") ||
                  (updatesByApp.get(y.id) ?? 0) - (updatesByApp.get(x.id) ?? 0) ||
                  x.displayName.localeCompare(y.displayName),
              )
              .map((a) => (
                <Tooltip key={a.id}>
                <TooltipTrigger asChild>
                <AppRow
                  app={{ ...a, tags: a.appTags.map((t) => t.tag.name) }}
                  href={`/apps/${a.name}`}
                  series={history.get(a.id)?.cpu}
                  updateCount={updatesByApp.get(a.id) ?? 0}
                  sharedStatus={sharedStatus}
                />
                </TooltipTrigger>
                <TooltipContent
                  /* Anchored under the row: side="right" collided and flipped onto the nav rail. */
                  side="bottom"
                  align="start"
                  sideOffset={4}
                  collisionPadding={12}
                  className="bg-popover text-popover-foreground border shadow-card-hover px-3 py-2.5 [&>span]:hidden"
                >
                  <AppRowCard
                    app={a}
                    updateCount={updatesByApp.get(a.id) ?? 0}
                    usage={metrics.get(a.id)}
                  />
                </TooltipContent>
                </Tooltip>
              ))}
          </div>
        )}
      </div>

      {/* Aggregate resource footer — space is held while stats stream in */}
      {activeCount > 0 && (
        <MetricsBand
          metrics={anyMetrics ? agg : undefined}
          history={aggregatedHistory}
          memoryLimit={memoryLimitTotal}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AppGrid
// ---------------------------------------------------------------------------

export function AppGrid({
  apps,
  allTags,
  orgId,
  emptyProjects = [],
}: AppGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("attention");
  const { metrics, history, historyTick } = useAppMetrics(orgId);
  const updates = useImageUpdates(orgId);
  const updatesByApp = useMemo(
    () => new Map((updates?.appsWithUpdates ?? []).map((a) => [a.id, a.count])),
    [updates],
  );

  // Bus events drive this list. This is the backstop for container state that
  // changed outside Vardo — the reconciler discovers it on a 60s poll and emits
  // nothing, so there is no point refreshing faster than that.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60000);
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
    return filterApps(list, query);
  }, [apps, activeTagIds, query]);

  // Group apps by project for rendering
  const projectCards = useMemo(() => {
    const byProject = new Map<string, { project: AppWithRelations["project"]; apps: AppWithRelations[] }>();

    for (const app of filtered) {
      const existing = byProject.get(app.project.id);
      if (existing) {
        existing.apps.push(app);
      } else {
        byProject.set(app.project.id, { project: app.project, apps: [app] });
      }
    }

    // Include empty projects that have no apps
    for (const ep of emptyProjects) {
      if (!byProject.has(ep.id) && matchesProject(ep, query)) {
        byProject.set(ep.id, { project: ep, apps: [] });
      }
    }

    return sortProjectCards(Array.from(byProject.values()), sort);
  }, [filtered, emptyProjects, query, sort]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
      {/* Find and order — the grid is the only path to an app that isn't the palette */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by app, project or domain"
            aria-label="Filter apps"
            className="squircle pl-8"
          />
        </div>
        <Select value={sort} onValueChange={(v) => isSortKey(v) && setSort(v)}>
          <SelectTrigger className="squircle w-44" aria-label="Sort projects">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((option) => (
              <SelectItem key={option.key} value={option.key}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {query.trim() && (
          <span className="text-xs text-muted-foreground">
            {filtered.length} app{filtered.length === 1 ? "" : "s"} in {projectCards.length} project
            {projectCards.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

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

      {/* Multi-column, not grid: app counts range from one to a dozen, and grid
          rows take the taller card's height, leaving a void under the shorter
          one. Column width drives the count, so a two-project install still
          fills the row. */}
      <div className="columns-[25rem] gap-4">
        {projectCards.map(({ project, apps: projectApps }) => (
          <div key={project.id} className="mb-4 break-inside-avoid">
            <ProjectCard
              project={project}
              projectApps={projectApps}
              metrics={metrics}
              history={history}
              historyTick={historyTick}
              updatesByApp={updatesByApp}
            />
          </div>
        ))}
      </div>

      {projectCards.length === 0 && (apps.length > 0 || emptyProjects.length > 0) && (
        <div className="squircle lining flex flex-col items-center justify-center gap-3 rounded-lg border bg-card p-12">
          <p className="text-sm text-muted-foreground">
            No apps match the current filters.
          </p>
          <button
            onClick={() => {
              setActiveTagIds(new Set());
              setQuery("");
            }}
            className="text-sm text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
