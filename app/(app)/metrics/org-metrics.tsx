"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Activity, Cpu, HardDrive, MemoryStick, Network, Loader2 } from "lucide-react";
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
  diskUsage: number;
  diskLimit: number;
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
  initialSystem?: SystemInfo | null;
  initialProjectStats?: { id: string; name: string; displayName: string; status: string; containers: ContainerStatsSnapshot[] }[];
};

function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

// Memory limit > 1TB is effectively "unlimited" (Docker reports host RAM or sentinel)
function formatMemLimit(bytes: number): string {
  if (bytes === 0 || bytes > 1099511627776) return "No limit";
  return formatBytes(bytes);
}

type TimePoint = {
  time: string;
  timestamp: number;
  cpu: number;
  memory: number;
  networkRx: number;
  networkTx: number;
  diskTotal: number;
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

type SystemInfo = {
  cpus: number;
  memoryTotal: number;
  os: string;
  dockerVersion: string;
  images: number;
  containers: number;
  containersRunning: number;
};

type DiskUsage = {
  images: { count: number; totalSize: number };
  containers: { count: number; totalSize: number };
  volumes: { count: number; totalSize: number };
  buildCache: { count: number; totalSize: number; reclaimable: number };
  total: number;
};

export function OrgMetrics({ orgId, projects, initialSystem, initialProjectStats }: OrgMetricsProps) {
  const [timeRange, setTimeRange] = useState<"5m" | "1h" | "6h" | "24h" | "7d">("1h");
  const [disk, setDisk] = useState<DiskUsage | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(initialSystem || null);
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;
  const [projectStats, setProjectStats] = useState<Record<string, ProjectStats>>(() => {
    const initial: Record<string, ProjectStats> = {};
    for (const p of projects) {
      const preloaded = initialProjectStats?.find((ip) => ip.id === p.id);
      initial[p.id] = {
        project: p,
        containers: preloaded?.containers || [],
        loading: !preloaded,
        error: null,
      };
    }
    return initial;
  });
  const [timeSeries, setTimeSeries] = useState<TimePoint[]>(() => {
    // Seed with initial data if available
    if (initialProjectStats?.length) {
      const allC = initialProjectStats.flatMap((p) => p.containers);
      const now = Date.now();
      return [{
        time: new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        timestamp: now,
        cpu: Math.round(allC.reduce((s, c) => s + c.cpuPercent, 0) * 100) / 100,
        memory: allC.reduce((s, c) => s + c.memoryUsage, 0),
        networkRx: allC.reduce((s, c) => s + c.networkRx, 0),
        networkTx: allC.reduce((s, c) => s + c.networkTx, 0),
        diskTotal: 0,
      }];
    }
    return [];
  });
  const statsRef = useRef(projectStats);

  // Load history when switching periods
  useEffect(() => {
    const rangeMs: Record<string, number> = { "5m": 300000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 };
    const bucketMs: Record<string, number> = { "5m": 5000, "1h": 30000, "6h": 120000, "24h": 300000, "7d": 1800000 };
    const now = Date.now();
    const from = now - rangeMs[timeRange];

    async function loadHistory() {
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/stats?from=${from}&to=${now}&bucket=${bucketMs[timeRange]}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) {
          // No history — seed with empty start point so chart shows full range
          setTimeSeries([{
            time: new Date(from).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestamp: from,
            cpu: 0, memory: 0, networkRx: 0, networkTx: 0, diskTotal: 0,
          }]);
          return;
        }
        const { series } = await res.json();

        // Seed start point at range start
        const startPoint: TimePoint = {
          time: new Date(from).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          timestamp: from,
          cpu: 0, memory: 0, networkRx: 0, networkTx: 0, diskTotal: 0,
        };

        if (!series?.cpu?.length) {
          setTimeSeries([startPoint]);
          return;
        }

        const points: TimePoint[] = series.cpu.map(([ts, cpu]: [number, number], i: number) => {
          const mem = series.memory?.[i] || [ts, 0];
          const rx = series.networkRx?.[i] || [ts, 0];
          const tx = series.networkTx?.[i] || [ts, 0];
          return {
            time: new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
            timestamp: ts,
            cpu: Math.round(cpu * 100) / 100,
            memory: mem[1],
            networkRx: rx[1],
            networkTx: tx[1],
            diskTotal: 0,
          };
        });

        // Prepend start point if history doesn't cover full range
        if (points[0]?.timestamp > from + 60000) {
          points.unshift(startPoint);
        }
        setTimeSeries(points);
      } catch {
        // Seed with empty start point
        setTimeSeries([{
          time: new Date(from).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          timestamp: from,
          cpu: 0, memory: 0, networkRx: 0, networkTx: 0, diskTotal: 0,
        }]);
      }
    }

    loadHistory();
  }, [orgId, timeRange]);

  // SSE stream — always running, appends live data to the chart
  useEffect(() => {
    const es = new EventSource(`/api/v1/organizations/${orgId}/stats/stream`);

    es.addEventListener("stats", (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          projects: { id: string; name: string; displayName: string; status: string; containers: ContainerStatsSnapshot[] }[];
          disk: DiskUsage | null;
          system: SystemInfo | null;
          timestamp: string;
        };

        if (payload.disk) setDisk(payload.disk);
        if (payload.system) setSystem(payload.system);

        // Update per-project stats
        setProjectStats((prev) => {
          const next = { ...prev };
          for (const p of payload.projects) {
            next[p.id] = {
              project: { id: p.id, name: p.name, displayName: p.displayName, status: p.status },
              containers: p.containers,
              loading: false,
              error: null,
            };
          }
          return next;
        });

        // Add time-series point
        const now = new Date(payload.timestamp).getTime();
        const allContainers = payload.projects.flatMap((p) => p.containers);
        const totalCpuNow = allContainers.reduce((s, c) => s + c.cpuPercent, 0);
        const totalMemNow = allContainers.reduce((s, c) => s + c.memoryUsage, 0);
        const totalRxNow = allContainers.reduce((s, c) => s + c.networkRx, 0);
        const totalTxNow = allContainers.reduce((s, c) => s + c.networkTx, 0);
        const rangeMs: Record<string, number> = { "5m": 300000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 };
        const cutoff = now - rangeMs[timeRangeRef.current];

        setTimeSeries((prev) => {
          const next = [...prev, {
            time: new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
            timestamp: now,
            cpu: Math.round(totalCpuNow * 100) / 100,
            memory: totalMemNow,
            networkRx: totalRxNow,
            networkTx: totalTxNow,
            diskTotal: payload.disk?.total || 0,
          }];
          // Trim data older than the selected time range
          return next.filter((p) => p.timestamp >= cutoff);
        });
      } catch {
        // Ignore parse errors
      }
    });

    es.onerror = () => {
      // Mark all as not loading so spinners stop
      setProjectStats((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (next[key].loading) {
            next[key] = { ...next[key], loading: false, error: "Connection lost" };
          }
        }
        return next;
      });
    };

    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

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
  const totalContainers = allStats.reduce(
    (sum, ps) => sum + ps.containers.length,
    0
  );
  const activeProjects = projects.filter((p) => p.status === "active").length;

  return (
    <div className="space-y-6">
      {/* Period switcher */}
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          {(["5m", "1h", "6h", "24h", "7d"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                timeRange === r
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${anyLoading ? "bg-status-neutral animate-pulse" : "bg-status-success"}`} />
          <span className="text-xs text-muted-foreground">Live</span>
        </div>
      </div>

      {/* System info */}
      {system && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>{system.cpus} CPUs</span>
          <span>{formatBytes(system.memoryTotal)} RAM</span>
          <span>{system.os}</span>
          <span>Docker {system.dockerVersion}</span>
          <span>{system.images} images</span>
        </div>
      )}

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
          <p className="text-xs text-muted-foreground">Disk</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {disk ? formatBytes(disk.total) : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
          </p>
          {disk && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {formatBytes(disk.images.totalSize)} images · {formatBytes(disk.volumes.totalSize)} volumes
            </p>
          )}
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Bandwidth</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {anyLoading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : formatBytes(totalNetworkRx + totalNetworkTx)}
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
      {(() => {
        const rangeMs: Record<string, number> = { "5m": 300000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 };
        const now = Date.now();
        const xDomain = [now - rangeMs[timeRange], now];
        const formatTick = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const xAxisProps = {
          dataKey: "timestamp" as const,
          type: "number" as const,
          domain: xDomain as [number, number],
          tick: { fontSize: 10, fill: "oklch(0.5 0.005 260)" },
          tickLine: false,
          axisLine: false,
          tickFormatter: formatTick,
          scale: "time" as const,
        };
        return (
      <div className="grid md:grid-cols-2 gap-4">
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Cpu className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">CPU</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260 / 40%)" />
                  <XAxis {...xAxisProps} />
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
              <h3 className="text-sm font-medium">Memory</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260 / 40%)" />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v)} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number) => [formatBytes(v), "Memory"]} />
                  <Area type="monotone" dataKey="memory" stroke="oklch(0.7 0.12 155)" fill="oklch(0.7 0.12 155 / 15%)" strokeWidth={1.5} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Network className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Network</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260 / 40%)" />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v)} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number, name: string) => [formatBytes(v), name === "networkRx" ? "↓ Received" : "↑ Sent"]} />
                  <Area type="monotone" dataKey="networkRx" stroke="oklch(0.7 0.12 240)" fill="oklch(0.7 0.12 240 / 10%)" strokeWidth={1.5} dot={false} />
                  <Area type="monotone" dataKey="networkTx" stroke="oklch(0.65 0.1 30)" fill="oklch(0.65 0.1 30 / 10%)" strokeWidth={1.5} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <HardDrive className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Disk Usage</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260 / 40%)" />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v)} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number) => [formatBytes(v), "Total"]} />
                  <Area type="monotone" dataKey="diskTotal" stroke="oklch(0.65 0.1 30)" fill="oklch(0.65 0.1 30 / 15%)" strokeWidth={1.5} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
      </div>
        );
      })()}

      {/* Project list with stats */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <Activity className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        </div>
      ) : (
        <div className="squircle rounded-lg border bg-card overflow-x-auto">
          {/* Header */}
          <div className="grid grid-cols-[1fr_70px_90px_100px_80px_80px] gap-3 px-4 py-2 border-b text-xs text-muted-foreground whitespace-nowrap min-w-[700px]">
            <span>Project</span>
            <span className="text-right">CPU</span>
            <span className="text-right">Memory</span>
            <span className="text-right">Network</span>
            <span className="text-right">Limit</span>
            <span className="text-right">Containers</span>
          </div>
          <div className="divide-y">
            {projects.map((project) => {
              const ps = projectStats[project.id];
              const cpu = ps?.containers.reduce((s, c) => s + c.cpuPercent, 0) ?? 0;
              const mem = ps?.containers.reduce((s, c) => s + c.memoryUsage, 0) ?? 0;
              const memLimit = Math.max(0, ...(ps?.containers.map((c) => c.memoryLimit) ?? [0]));
              const netRx = ps?.containers.reduce((s, c) => s + c.networkRx, 0) ?? 0;
              const netTx = ps?.containers.reduce((s, c) => s + c.networkTx, 0) ?? 0;

              const containerCount = ps?.containers.length ?? 0;
              const isActive = project.status === "active";
              const loading = ps?.loading;

              return (
                <Link
                  key={project.id}
                  href={`/projects/${project.name}/metrics`}
                  className="grid grid-cols-[1fr_70px_90px_100px_80px_80px] gap-3 px-4 py-3 hover:bg-accent/50 transition-colors items-center whitespace-nowrap min-w-[700px]"
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
                    {loading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive && memLimit > 0 ? formatMemLimit(memLimit) : "-"}
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
