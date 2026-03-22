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
import { formatBytes, formatMemLimit } from "@/lib/metrics/format";
import { RANGE_MS, BUCKET_MS, chartTooltipStyle, type TimeRange } from "@/lib/metrics/constants";
import type { ContainerStatsSnapshot, TimePoint } from "@/lib/metrics/types";
import { useVisibilityKey } from "@/lib/hooks/use-visible";
import type { SystemInfo, DiskUsage } from "@/lib/docker/client";

type AppSummary = {
  id: string;
  name: string;
  displayName: string;
  status: string;
};

type AppStats = {
  app: AppSummary;
  containers: ContainerStatsSnapshot[];
  loading: boolean;
  error: string | null;
};

type OrgMetricsProps = {
  orgId: string;
  apps: AppSummary[];
  initialSystem?: SystemInfo | null;
  initialAppStats?: { id: string; name: string; displayName: string; status: string; containers: ContainerStatsSnapshot[] }[];
  initialDisk?: { total: number; images: number; volumes: number; buildCache: number } | null;
  /** When true, uses admin system-wide endpoints instead of org-scoped ones */
  adminMode?: boolean;
};

export function OrgMetrics({ orgId, apps, initialSystem, initialAppStats, initialDisk, adminMode }: OrgMetricsProps) {
  const visKey = useVisibilityKey();
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [disk, setDisk] = useState<DiskUsage | null>(initialDisk ? {
    images: { count: 0, totalSize: initialDisk.images, reclaimable: 0 },
    containers: { count: 0, totalSize: 0 },
    volumes: { count: 0, totalSize: initialDisk.volumes },
    buildCache: { count: 0, totalSize: initialDisk.buildCache, reclaimable: 0 },
    total: initialDisk.total,
  } : null);
  const [system, setSystem] = useState<SystemInfo | null>(initialSystem || null);
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;

  // Stable chart domain — only updates when timeRange changes, not every tick
  const [chartDomain, setChartDomain] = useState<[number, number]>(() => {
    const now = Date.now();
    return [now - RANGE_MS[timeRange], now];
  });

  // Update domain when time range changes, and slowly advance the right edge every 30s
  useEffect(() => {
    const now = Date.now();
    setChartDomain([now - RANGE_MS[timeRange], now]);

    // Advance right edge every 30s so the chart slowly scrolls
    const interval = setInterval(() => {
      const n = Date.now();
      setChartDomain([n - RANGE_MS[timeRange], n]);
    }, 30000);
    return () => clearInterval(interval);
  }, [timeRange]);
  const [appStats, setAppStats] = useState<Record<string, AppStats>>(() => {
    const initial: Record<string, AppStats> = {};
    for (const p of apps) {
      const preloaded = initialAppStats?.find((ip) => ip.id === p.id);
      initial[p.id] = {
        app: p,
        containers: preloaded?.containers || [],
        loading: !preloaded,
        error: null,
      };
    }
    return initial;
  });
  const [timeSeries, setTimeSeries] = useState<TimePoint[]>(() => {
    // Seed with initial data if available
    if (initialAppStats?.length) {
      const allC = initialAppStats.flatMap((p) => p.containers);
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
  const diskRef = useRef(disk);
  diskRef.current = disk;
  const systemRef = useRef(system);
  systemRef.current = system;

  // Load history when switching periods
  useEffect(() => {
    const now = Date.now();
    const from = now - RANGE_MS[timeRange];

    async function loadHistory() {
      try {
        const res = await fetch(
          adminMode
            ? `/api/v1/admin/stats?from=${from}&to=${now}&bucket=${BUCKET_MS[timeRange]}`
            : `/api/v1/organizations/${orgId}/stats?from=${from}&to=${now}&bucket=${BUCKET_MS[timeRange]}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) {
          // No history — seed with empty start point so chart shows full range
          setTimeSeries([{
            time: new Date(from).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            timestamp: from,
            cpu: 0, memory: 0, networkRx: 0, networkTx: 0, diskTotal: initialDisk?.total || 0,
          }]);
          return;
        }
        const { series } = await res.json();

        // Seed start point at range start
        const startPoint: TimePoint = {
          time: new Date(from).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          timestamp: from,
          cpu: 0, memory: 0, networkRx: 0, networkTx: 0, diskTotal: initialDisk?.total || 0,
        };

        if (!series?.cpu?.length) {
          setTimeSeries([startPoint]);
          return;
        }

        // Build disk lookup by nearest timestamp
        const diskMap = new Map<number, number>();
        if (series.disk) {
          for (const [ts, val] of series.disk as [number, number][]) {
            diskMap.set(ts, val);
          }
        }
        // Find nearest disk value for a given timestamp
        const nearestDisk = (ts: number): number => {
          if (diskMap.has(ts)) return diskMap.get(ts)!;
          let best = initialDisk?.total || 0;
          let bestDist = Infinity;
          for (const [dts, dval] of diskMap) {
            const dist = Math.abs(dts - ts);
            if (dist < bestDist) { bestDist = dist; best = dval; }
          }
          return best;
        };

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
            diskTotal: nearestDisk(ts),
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
          cpu: 0, memory: 0, networkRx: 0, networkTx: 0, diskTotal: initialDisk?.total || 0,
        }]);
      }
    }

    loadHistory();
  }, [orgId, timeRange]);

  // SSE stream — disconnects when tab hidden, reconnects when visible
  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return;

    const streamUrl = adminMode
      ? `/api/v1/admin/stats/stream`
      : `/api/v1/organizations/${orgId}/stats/stream`;
    const es = new EventSource(streamUrl);

    es.addEventListener("stats", (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          apps: { id: string; name: string; displayName: string; status: string; containers: ContainerStatsSnapshot[] }[];
          disk: DiskUsage | null;
          system: SystemInfo | null;
          timestamp: string;
        };

        if (payload.disk && JSON.stringify(payload.disk) !== JSON.stringify(diskRef.current)) setDisk(payload.disk);
        if (payload.system && JSON.stringify(payload.system) !== JSON.stringify(systemRef.current)) setSystem(payload.system);

        // Update per-app stats
        setAppStats((prev) => {
          const next = { ...prev };
          for (const p of payload.apps) {
            next[p.id] = {
              app: { id: p.id, name: p.name, displayName: p.displayName, status: p.status },
              containers: p.containers,
              loading: false,
              error: null,
            };
          }
          return next;
        });

        // Add time-series point
        const now = new Date(payload.timestamp).getTime();
        const allContainers = payload.apps.flatMap((p) => p.containers);
        const totalCpuNow = allContainers.reduce((s, c) => s + c.cpuPercent, 0);
        const totalMemNow = allContainers.reduce((s, c) => s + c.memoryUsage, 0);
        const totalRxNow = allContainers.reduce((s, c) => s + c.networkRx, 0);
        const totalTxNow = allContainers.reduce((s, c) => s + c.networkTx, 0);
        const cutoff = now - RANGE_MS[timeRangeRef.current];

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
      setAppStats((prev) => {
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
  }, [orgId, adminMode, visKey]);

  const allStats = Object.values(appStats);
  const anyLoading = allStats.some((s) => s.loading);

  // Totals across all apps
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
  const activeApps = apps.filter((p) => p.status === "active").length;

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
          <p className="text-xs text-muted-foreground">Apps</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">{activeApps}</p>
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
        const formatTick = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const xAxisProps = {
          dataKey: "timestamp" as const,
          type: "number" as const,
          domain: chartDomain as [number, number],
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
                  <Area type="monotone" dataKey="cpu" stroke="oklch(0.7 0.12 240)" fill="oklch(0.7 0.12 240 / 15%)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
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
                  <Area type="monotone" dataKey="memory" stroke="oklch(0.7 0.12 155)" fill="oklch(0.7 0.12 155 / 15%)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
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
                  <Area type="monotone" dataKey="networkRx" stroke="oklch(0.7 0.12 240)" fill="oklch(0.7 0.12 240 / 10%)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Area type="monotone" dataKey="networkTx" stroke="oklch(0.65 0.1 30)" fill="oklch(0.65 0.1 30 / 10%)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
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
                  <Area type="monotone" dataKey="diskTotal" stroke="oklch(0.65 0.1 30)" fill="oklch(0.65 0.1 30 / 15%)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
      </div>
        );
      })()}

      {/* Project list with stats */}
      {apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
          <Activity className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No apps yet.</p>
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
            {apps.map((a) => {
              const ps = appStats[a.id];
              const cpu = ps?.containers.reduce((s, c) => s + c.cpuPercent, 0) ?? 0;
              const mem = ps?.containers.reduce((s, c) => s + c.memoryUsage, 0) ?? 0;
              const memLimit = Math.max(0, ...(ps?.containers.map((c) => c.memoryLimit) ?? [0]));
              const netRx = ps?.containers.reduce((s, c) => s + c.networkRx, 0) ?? 0;
              const netTx = ps?.containers.reduce((s, c) => s + c.networkTx, 0) ?? 0;

              const containerCount = ps?.containers.length ?? 0;
              const isActive = a.status === "active";
              const loading = ps?.loading;

              return (
                <Link
                  key={a.id}
                  href={`/apps/${a.name}/metrics`}
                  className="grid grid-cols-[1fr_70px_90px_100px_80px_80px] gap-3 px-4 py-3 hover:bg-accent/50 transition-colors items-center whitespace-nowrap min-w-[700px]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`size-2 rounded-full shrink-0 ${
                        isActive ? "bg-status-success" : "bg-status-neutral"
                      }`}
                    />
                    <span className="text-sm font-medium truncate">
                      {a.displayName}
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
