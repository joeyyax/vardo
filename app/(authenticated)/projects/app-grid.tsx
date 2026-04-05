"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Cpu } from "lucide-react";
import { EndpointsPopover } from "@/components/endpoints-popover";
import { detectAppType } from "@/lib/ui/app-type";
import { statusDotColor } from "@/lib/ui/status-colors";
import { StatusIndicator } from "@/components/app-status";
import { SystemBadge } from "@/components/system-badge";

import {
  type AppMetrics,
  type MetricsHistory,
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
  projectId: string;
  gpuEnabled: boolean | null;
  status: string;
  needsRedeploy: boolean | null;
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
}: {
  project: NonNullable<AppWithRelations["project"]>;
  projectApps: AppWithRelations[];
  metrics: Map<string, AppMetrics>;
  history: Map<string, MetricsHistory>;
  historyTick: number;
}) {
  const color = "#a1a1aa"; // neutral zinc-400 — project color is unused

  // Aggregate status from all apps
  const allActive = projectApps.every((a) => a.status === "active");
  const anyError = projectApps.some((a) => a.status === "error");
  const anyDeploying = projectApps.some((a) => a.status === "deploying");
  const status = allActive ? "running" : anyError ? "error" : anyDeploying ? "deploying" : "stopped";

  // Aggregated CPU across all apps
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

  return (
    <Link
      href={`/projects/${project.name}`}
      className={`squircle relative flex flex-col rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 overflow-hidden cursor-pointer${isSystem ? " ring-2 ring-status-warning/50" : ""}`}
    >
      {aggregatedCpu.length > 0 && (
        <Sparkline
          data={aggregatedCpu}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ color: "oklch(0.65 0.19 255)" }}
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
              {isSystem && <SystemBadge compact className="shrink-0" />}
              <EndpointsPopover endpoints={projectApps.flatMap((a) => a.domains.map((d) => ({ label: a.displayName, domain: d.domain })))} />
            </div>
            {projectApps.length > 0 ? (
              <StatusIndicator
                status={status}
                finishedAt={allActive ? (() => {
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
                needsRedeploy={projectApps.some((a) => !!a.needsRedeploy)}
              />
            ) : (
              <span className="text-xs text-muted-foreground">Empty</span>
            )}
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
        {projectApps.length === 0 && (
          <Link
            href={`/apps/new?project=${project.id}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <Plus className="size-3" />
            Add App
          </Link>
        )}
        {projectApps.map((a) => (
            <Link
              key={a.id}
              href={`/apps/${a.name}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-xs font-medium bg-background hover:bg-accent transition-colors cursor-pointer"
            >
              <span aria-hidden="true" className={`size-1.5 rounded-full ${statusDotColor(a.status)}`} />
              {a.displayName}
              {a.gpuEnabled && (
                <Cpu className="size-3 text-muted-foreground/50" aria-label="GPU passthrough enabled" />
              )}
              <span className="sr-only">
                {a.status === "active" ? ", Running" : a.status === "error" ? ", Crashed" : a.status === "deploying" ? ", Deploying" : ", Stopped"}
              </span>
            </Link>
        ))}
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
  emptyProjects = [],
}: AppGridProps) {
  const router = useRouter();
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const { metrics, history, historyTick } = useAppMetrics(orgId);

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
