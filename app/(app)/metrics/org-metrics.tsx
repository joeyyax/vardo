"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Activity, Loader2 } from "lucide-react";

type ProjectSummary = {
  id: string;
  name: string;
  displayName: string;
  status: string;
};

type ContainerStatsSnapshot = {
  containerId: string;
  containerName: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  blockRead: number;
  blockWrite: number;
};

type ProjectStats = {
  project: ProjectSummary;
  containers: ContainerStatsSnapshot[];
  loading: boolean;
  error: string | null;
};

type OrgMetricsProps = {
  orgId: string;
  projects: ProjectSummary[];
};

function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function OrgMetrics({ orgId, projects }: OrgMetricsProps) {
  const [projectStats, setProjectStats] = useState<Record<string, ProjectStats>>(() => {
    const initial: Record<string, ProjectStats> = {};
    for (const p of projects) {
      initial[p.id] = { project: p, containers: [], loading: true, error: null };
    }
    return initial;
  });

  useEffect(() => {
    const activeProjects = projects.filter((p) => p.status === "active");

    if (activeProjects.length === 0) return;

    // Fetch stats for each active project
    async function fetchAll() {
      const results = await Promise.allSettled(
        activeProjects.map(async (p) => {
          const res = await fetch(`/api/v1/organizations/${orgId}/projects/${p.id}/stats`);
          if (!res.ok) throw new Error("Failed to fetch");
          const data = await res.json();
          return { projectId: p.id, containers: data.containers as ContainerStatsSnapshot[] };
        })
      );

      setProjectStats((prev) => {
        const next = { ...prev };
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const projectId = activeProjects[i].id;
          if (result.status === "fulfilled") {
            next[projectId] = {
              ...next[projectId],
              containers: result.value.containers,
              loading: false,
              error: null,
            };
          } else {
            next[projectId] = {
              ...next[projectId],
              containers: [],
              loading: false,
              error: "Failed to fetch stats",
            };
          }
        }
        return next;
      });
    }

    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, [orgId, projects]);

  const allStats = Object.values(projectStats);
  const anyLoading = allStats.some((s) => s.loading);

  // Totals across all projects
  const totalCpu = allStats.reduce(
    (sum, ps) => sum + ps.containers.reduce((s, c) => s + c.cpuPercent, 0),
    0
  );
  const totalMemory = allStats.reduce(
    (sum, ps) => sum + ps.containers.reduce((s, c) => s + c.memoryUsage, 0),
    0
  );
  const totalContainers = allStats.reduce(
    (sum, ps) => sum + ps.containers.length,
    0
  );
  const activeProjects = projects.filter((p) => p.status === "active").length;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Total CPU</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {anyLoading ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              `${totalCpu.toFixed(1)}%`
            )}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Total Memory</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {anyLoading ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              formatBytes(totalMemory)
            )}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Active Projects</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {activeProjects}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Containers</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {anyLoading ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              totalContainers
            )}
          </p>
        </div>
      </div>

      {/* Project list with stats */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <Activity className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        </div>
      ) : (
        <div className="squircle rounded-lg border bg-card overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[1fr_80px_100px_100px_80px] gap-4 px-4 py-2 border-b text-xs text-muted-foreground">
            <span>Project</span>
            <span className="text-right">CPU</span>
            <span className="text-right">Memory</span>
            <span className="text-right">Limit</span>
            <span className="text-right">Containers</span>
          </div>
          <div className="divide-y">
            {projects.map((project) => {
              const ps = projectStats[project.id];
              const cpu = ps?.containers.reduce((s, c) => s + c.cpuPercent, 0) ?? 0;
              const mem = ps?.containers.reduce((s, c) => s + c.memoryUsage, 0) ?? 0;
              const memLimit = ps?.containers.reduce((s, c) => s + c.memoryLimit, 0) ?? 0;
              const containerCount = ps?.containers.length ?? 0;
              const isActive = project.status === "active";

              return (
                <Link
                  key={project.id}
                  href={`/projects/${project.name}/metrics`}
                  className="grid grid-cols-[1fr_80px_100px_100px_80px] gap-4 px-4 py-3 hover:bg-accent/50 transition-colors items-center"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`size-2 rounded-full shrink-0 ${
                        isActive ? "bg-status-success" : "bg-status-neutral"
                      }`}
                    />
                    <span className="text-sm font-medium truncate">
                      {project.displayName}
                    </span>
                  </div>
                  <span className="text-sm text-right tabular-nums text-muted-foreground">
                    {ps?.loading ? (
                      <Loader2 className="size-3.5 animate-spin ml-auto" />
                    ) : isActive ? (
                      `${cpu.toFixed(1)}%`
                    ) : (
                      "-"
                    )}
                  </span>
                  <span className="text-sm text-right tabular-nums text-muted-foreground">
                    {ps?.loading ? (
                      <Loader2 className="size-3.5 animate-spin ml-auto" />
                    ) : isActive && mem > 0 ? (
                      formatBytes(mem)
                    ) : (
                      "-"
                    )}
                  </span>
                  <span className="text-sm text-right tabular-nums text-muted-foreground">
                    {ps?.loading ? (
                      <Loader2 className="size-3.5 animate-spin ml-auto" />
                    ) : isActive && memLimit > 0 ? (
                      formatBytes(memLimit)
                    ) : (
                      "-"
                    )}
                  </span>
                  <span className="text-sm text-right tabular-nums text-muted-foreground">
                    {ps?.loading ? (
                      <Loader2 className="size-3.5 animate-spin ml-auto" />
                    ) : isActive ? (
                      containerCount
                    ) : (
                      "-"
                    )}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
