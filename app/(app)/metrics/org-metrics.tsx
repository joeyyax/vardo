"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Activity, Cpu, MemoryStick, Loader2 } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

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

type TimePoint = {
  time: string;
  timestamp: number;
  cpu: number;
  memory: number;
};

const MAX_POINTS = 60; // 5 minutes at 5s intervals

const chartTooltipStyle = {
  contentStyle: {
    backgroundColor: "oklch(0.14 0.005 260)",
    border: "1px solid oklch(0.25 0.005 260)",
    borderRadius: "8px",
    fontSize: "12px",
    color: "oklch(0.87 0.005 260)",
  },
  itemStyle: { color: "oklch(0.87 0.005 260)" },
  labelStyle: { color: "oklch(0.55 0.005 260)" },
};

export function OrgMetrics({ orgId, projects }: OrgMetricsProps) {
  const [projectStats, setProjectStats] = useState<Record<string, ProjectStats>>(() => {
    const initial: Record<string, ProjectStats> = {};
    for (const p of projects) {
      initial[p.id] = { project: p, containers: [], loading: true, error: null };
    }
    return initial;
  });
  const [timeSeries, setTimeSeries] = useState<TimePoint[]>([]);
  const statsRef = useRef(projectStats);

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
        statsRef.current = next;
        return next;
      });

      // Add time-series point from aggregated stats
      const now = Date.now();
      const allContainers = results
        .filter((r): r is PromiseFulfilledResult<{ projectId: string; containers: ContainerStatsSnapshot[] }> => r.status === "fulfilled")
        .flatMap((r) => r.value.containers);
      const totalCpuNow = allContainers.reduce((s, c) => s + c.cpuPercent, 0);
      const totalMemNow = allContainers.reduce((s, c) => s + c.memoryUsage, 0);

      setTimeSeries((prev) => {
        const next = [...prev, {
          time: new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          timestamp: now,
          cpu: Math.round(totalCpuNow * 100) / 100,
          memory: totalMemNow,
        }];
        return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
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
  const totalNetworkRx = allStats.reduce(
    (sum, ps) => sum + ps.containers.reduce((s, c) => s + c.networkRx, 0),
    0
  );
  const totalNetworkTx = allStats.reduce(
    (sum, ps) => sum + ps.containers.reduce((s, c) => s + c.networkTx, 0),
    0
  );
  const totalDiskRead = allStats.reduce(
    (sum, ps) => sum + ps.containers.reduce((s, c) => s + c.blockRead, 0),
    0
  );
  const totalDiskWrite = allStats.reduce(
    (sum, ps) => sum + ps.containers.reduce((s, c) => s + c.blockWrite, 0),
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">CPU</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {anyLoading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : `${totalCpu.toFixed(1)}%`}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Memory</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {anyLoading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : formatBytes(totalMemory)}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Network</p>
          <p className="text-lg font-semibold tabular-nums mt-1">
            {anyLoading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : (
              <><span className="text-muted-foreground text-xs">↓</span> {formatBytes(totalNetworkRx)} <span className="text-muted-foreground text-xs">↑</span> {formatBytes(totalNetworkTx)}</>
            )}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Disk I/O</p>
          <p className="text-lg font-semibold tabular-nums mt-1">
            {anyLoading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : (
              <><span className="text-muted-foreground text-xs">R</span> {formatBytes(totalDiskRead)} <span className="text-muted-foreground text-xs">W</span> {formatBytes(totalDiskWrite)}</>
            )}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Projects</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">{activeProjects}</p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Containers</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {anyLoading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : totalContainers}
          </p>
        </div>
      </div>

      {/* Aggregate charts */}
      {timeSeries.length > 1 && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Cpu className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Total CPU Usage</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260)" />
                  <XAxis dataKey="time" tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number) => [`${v.toFixed(1)}%`, "CPU"]} />
                  <Area type="monotone" dataKey="cpu" stroke="oklch(0.7 0.12 240)" fill="oklch(0.7 0.12 240 / 15%)" strokeWidth={1.5} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <MemoryStick className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Total Memory Usage</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260)" />
                  <XAxis dataKey="time" tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v)} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number) => [formatBytes(v), "Memory"]} />
                  <Area type="monotone" dataKey="memory" stroke="oklch(0.7 0.12 155)" fill="oklch(0.7 0.12 155 / 15%)" strokeWidth={1.5} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Project list with stats */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <Activity className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        </div>
      ) : (
        <div className="squircle rounded-lg border bg-card overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[1fr_70px_90px_90px_90px_90px_70px] gap-3 px-4 py-2 border-b text-xs text-muted-foreground">
            <span>Project</span>
            <span className="text-right">CPU</span>
            <span className="text-right">Memory</span>
            <span className="text-right">Network</span>
            <span className="text-right">Disk I/O</span>
            <span className="text-right">Limit</span>
            <span className="text-right">Ctrs</span>
          </div>
          <div className="divide-y">
            {projects.map((project) => {
              const ps = projectStats[project.id];
              const cpu = ps?.containers.reduce((s, c) => s + c.cpuPercent, 0) ?? 0;
              const mem = ps?.containers.reduce((s, c) => s + c.memoryUsage, 0) ?? 0;
              const memLimit = ps?.containers.reduce((s, c) => s + c.memoryLimit, 0) ?? 0;
              const netRx = ps?.containers.reduce((s, c) => s + c.networkRx, 0) ?? 0;
              const netTx = ps?.containers.reduce((s, c) => s + c.networkTx, 0) ?? 0;
              const diskR = ps?.containers.reduce((s, c) => s + c.blockRead, 0) ?? 0;
              const diskW = ps?.containers.reduce((s, c) => s + c.blockWrite, 0) ?? 0;
              const containerCount = ps?.containers.length ?? 0;
              const isActive = project.status === "active";
              const loading = ps?.loading;

              return (
                <Link
                  key={project.id}
                  href={`/projects/${project.name}/metrics`}
                  className="grid grid-cols-[1fr_70px_90px_90px_90px_90px_70px] gap-3 px-4 py-3 hover:bg-accent/50 transition-colors items-center"
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
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {loading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive ? `${cpu.toFixed(1)}%` : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {loading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive && mem > 0 ? formatBytes(mem) : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {loading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive && (netRx > 0 || netTx > 0) ? (
                      <>{formatBytes(netRx)} / {formatBytes(netTx)}</>
                    ) : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {loading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive && (diskR > 0 || diskW > 0) ? (
                      <>{formatBytes(diskR)} / {formatBytes(diskW)}</>
                    ) : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {loading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive && memLimit > 0 ? formatBytes(memLimit) : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {loading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive ? containerCount : "-"}
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
