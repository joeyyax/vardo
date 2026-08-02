"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { Plus, Cpu, ShieldCheck, Trash2, Package } from "lucide-react";
import { EndpointsPopover } from "@/components/endpoints-popover";
import { detectAppType } from "@/lib/ui/app-type";
import { statusDotColor, uniformStatus } from "@/lib/ui/status-colors";
import { conditionLabel, conditionTone, countNeedingAttention } from "@/lib/ui/conditions";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { AppRowCard } from "@/components/app-row-card";
import { worstCondition, type AppCondition } from "@/lib/docker/conditions";
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

// App list: healthy is quiet, deviation is tinted and worded, problems sort first.
const STATUS_RANK: Record<string, number> = {
  error: 0,
  missing: 1,
  deploying: 2,
  stopped: 3,
  active: 4,
};

const STATUS_WORD: Record<string, string> = {
  error: "crashed",
  missing: "no container",
  deploying: "deploying",
  stopped: "stopped",
};

const STATUS_WORD_TONE: Record<string, string> = {
  error: "text-status-error",
  missing: "text-status-warning",
  deploying: "text-status-info",
  stopped: "text-muted-foreground",
};

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
        Deploy failed {formatDistanceToNowStrict(new Date(lastDeploy.startedAt), { addSuffix: true })}
      </span>
    ) : lastDeploy.status === "running" || lastDeploy.status === "queued" ? (
      <span className="text-status-info">Deploying now</span>
    ) : (
      <span>Deployed {formatDistanceToNowStrict(new Date(lastDeploy.startedAt), { addSuffix: true })}</span>
    )
  );

  return (
    <div className="squircle relative flex flex-col rounded-lg bg-card shadow-card dark:border transition-shadow hover:shadow-card-hover overflow-hidden">
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
          <div className="flex items-center justify-between gap-2">
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
            Add App
          </Link>
        ) : (
          <div className="grid content-start gap-x-6 sm:grid-cols-2">
            {[...projectApps]
              .sort(
                (x, y) =>
                  (STATUS_RANK[x.status] ?? 3) - (STATUS_RANK[y.status] ?? 3) ||
                  Number(y.priority === "critical") - Number(x.priority === "critical") ||
                  (updatesByApp.get(y.id) ?? 0) - (updatesByApp.get(x.id) ?? 0) ||
                  x.displayName.localeCompare(y.displayName),
              )
              .map((a) => (
                <Tooltip key={a.id}>
                <TooltipTrigger asChild>
                <Link
                  href={`/apps/${a.name}`}
                  className="relative z-10 flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer hover:bg-card"
                >
                  <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${statusDotColor(a.status)}`} />
                  <span className="truncate">{a.displayName}</span>
                  {STATUS_WORD[a.status] && a.status !== sharedStatus && (
                    <span className={`shrink-0 font-normal ${STATUS_WORD_TONE[a.status]}`}>
                      {STATUS_WORD[a.status]}
                    </span>
                  )}
                  {(() => {
                    const worst = worstCondition(a.conditions ?? []);
                    if (!worst) return null;
                    return (
                      <span
                        className={`shrink-0 font-normal ${conditionTone(worst.severity)}`}
                        title={worst.detail}
                      >
                        {conditionLabel(worst)}
                      </span>
                    );
                  })()}
                  {a.status === "active" && <span className="sr-only">, Running</span>}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {(updatesByApp.get(a.id) ?? 0) > 0 && (
                      <Package className="size-3 text-muted-foreground/70" aria-label="Update available" />
                    )}
                    {a.priority === "critical" && (
                      <ShieldCheck className="size-3 text-status-warning" aria-label="Critical priority" />
                    )}
                    {a.priority === "disposable" && (
                      <Trash2 className="size-3 text-muted-foreground/50" aria-label="Disposable priority" />
                    )}
                    {a.gpuEnabled && (
                      <Cpu className="size-3 text-muted-foreground/50" aria-label="GPU passthrough enabled" />
                    )}
                  </span>
                </Link>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  align="start"
                  sideOffset={6}
                  className="bg-popover text-popover-foreground border shadow-card-hover px-3 py-2.5 [&>span]:hidden"
                >
                  <AppRowCard app={a} updateCount={updatesByApp.get(a.id) ?? 0} />
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
  const { metrics, history, historyTick } = useAppMetrics(orgId);
  const updates = useImageUpdates(orgId);
  const updatesByApp = useMemo(
    () => new Map((updates?.appsWithUpdates ?? []).map((a) => [a.id, a.count])),
    [updates],
  );

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 30000);
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
      if (!byProject.has(ep.id)) {
        byProject.set(ep.id, { project: ep, apps: [] });
      }
    }

    return Array.from(byProject.values());
  }, [filtered, emptyProjects]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
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

      {filtered.length === 0 && apps.length > 0 && (
        <div className="squircle lining flex flex-col items-center justify-center gap-3 rounded-lg border bg-card p-12">
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
    </div>
  );
}
