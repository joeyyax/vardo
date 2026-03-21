"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { Activity, Box, Cpu, HardDrive, MemoryStick, Network, Loader2 } from "lucide-react";
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
import { RANGE_MS, chartTooltipStyle, type TimeRange } from "@/lib/metrics/constants";
import { useMetricsStream } from "@/lib/hooks/use-metrics-stream";
import { Sparkline } from "@/components/app-metrics-card";
import { CHART_COLORS } from "@/lib/metrics/constants";
import type { SystemInfo, DiskUsage } from "@/lib/docker/client";

type AppSummary = {
  id: string;
  name: string;
  displayName: string;
  status: string;
};

type OrgMetricsProps = {
  orgId: string;
  apps: AppSummary[];
  /** When true, uses admin system-wide endpoints instead of org-scoped ones */
  adminMode?: boolean;
};

type AppMeta = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  containers: { cpuPercent: number; memoryUsage: number; memoryLimit: number; networkRx: number; networkTx: number }[];
};

export function OrgMetrics({ orgId, apps, adminMode }: OrgMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  // Stable chart domain — only updates when timeRange changes, not every tick
  const [chartDomain, setChartDomain] = useState<[number, number]>(() => {
    const now = Date.now();
    return [now - RANGE_MS[timeRange], now];
  });

  // Update domain when time range changes, and slowly advance the right edge every 30s
  useEffect(() => {
    const now = Date.now();
    setChartDomain([now - RANGE_MS[timeRange], now]);

    const interval = setInterval(() => {
      const n = Date.now();
      setChartDomain([n - RANGE_MS[timeRange], n]);
    }, 30000);
    return () => clearInterval(interval);
  }, [timeRange]);

  const historyUrl = adminMode
    ? `/api/v1/admin/stats`
    : `/api/v1/organizations/${orgId}/stats`;
  const streamUrl = adminMode
    ? `/api/v1/admin/stats/stream`
    : `/api/v1/organizations/${orgId}/stats/stream`;

  const { points, meta, connected, loading } = useMetricsStream({
    historyUrl,
    streamUrl,
    timeRange,
  });

  const disk = meta?.disk as DiskUsage | null | undefined;
  const system = meta?.system as SystemInfo | null | undefined;
  const metaApps = meta?.apps as AppMeta[] | undefined;

  // Derive display apps from SSE meta when available, fall back to props
  const displayApps = useMemo(() => {
    if (metaApps && metaApps.length > 0) {
      return metaApps.map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        status: a.status,
      }));
    }
    return apps;
  }, [metaApps, apps]);

  // Build per-app stats lookup from SSE apps data
  const appStats = useMemo(() => {
    const map: Record<string, AppMeta> = {};
    if (metaApps) {
      for (const a of metaApps) {
        map[a.id] = a;
      }
    }
    return map;
  }, [metaApps]);

  // Totals from latest point or from meta apps containers
  const totals = useMemo(() => {
    if (metaApps && metaApps.length > 0) {
      const allContainers = metaApps.flatMap((a) => a.containers);
      return {
        cpu: allContainers.reduce((s, c) => s + c.cpuPercent, 0),
        memory: allContainers.reduce((s, c) => s + c.memoryUsage, 0),
        networkRx: allContainers.reduce((s, c) => s + c.networkRx, 0),
        networkTx: allContainers.reduce((s, c) => s + c.networkTx, 0),
        containers: allContainers.length,
      };
    }
    // Fall back to latest point
    const latest = points[points.length - 1];
    if (latest) {
      return {
        cpu: latest.cpu,
        memory: latest.memory,
        networkRx: latest.networkRx,
        networkTx: latest.networkTx,
        containers: 0,
      };
    }
    return { cpu: 0, memory: 0, networkRx: 0, networkTx: 0, containers: 0 };
  }, [metaApps, points]);

  const activeApps = displayApps.filter((p) => p.status === "active").length;

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
          <span className={`size-2 rounded-full ${loading ? "bg-status-neutral animate-pulse" : connected ? "bg-status-success" : "bg-status-neutral"}`} />
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

      {/* Summary cards with sparklines */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="squircle relative rounded-lg border bg-card px-4 py-3 overflow-hidden">
          {points.length > 1 && (
            <Sparkline data={points.map((p) => p.cpu)} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.cpu }} />
          )}
          <div className="relative flex items-center gap-2">
            <Cpu className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">CPU</p>
          </div>
          <p className="relative text-2xl font-semibold tabular-nums mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : `${totals.cpu.toFixed(1)}%`}
          </p>
        </div>
        <div className="squircle relative rounded-lg border bg-card px-4 py-3 overflow-hidden">
          {points.length > 1 && (
            <Sparkline data={points.map((p) => p.memory)} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.memory }} />
          )}
          <div className="relative flex items-center gap-2">
            <MemoryStick className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Memory</p>
          </div>
          <p className="relative text-2xl font-semibold tabular-nums mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : formatBytes(totals.memory)}
          </p>
        </div>
        <div className="squircle relative rounded-lg border bg-card px-4 py-3 overflow-hidden">
          {points.length > 1 && (
            <Sparkline data={points.map((p) => p.diskTotal)} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: "oklch(0.65 0.1 30)" }} />
          )}
          <div className="relative flex items-center gap-2">
            <HardDrive className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Disk</p>
          </div>
          <p className="relative text-2xl font-semibold tabular-nums mt-1">
            {disk ? formatBytes(disk.total) : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
          </p>
          {disk && (
            <p className="relative text-[10px] text-muted-foreground mt-0.5">
              {formatBytes(disk.images.totalSize)} images · {formatBytes(disk.volumes.totalSize)} volumes
            </p>
          )}
        </div>
        <div className="squircle relative rounded-lg border bg-card px-4 py-3 overflow-hidden">
          {points.length > 1 && (
            <Sparkline data={points.map((p) => p.networkRx + p.networkTx)} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.networkRx }} />
          )}
          <div className="relative flex items-center gap-2">
            <Network className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Bandwidth</p>
          </div>
          <p className="relative text-2xl font-semibold tabular-nums mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : formatBytes(totals.networkRx + totals.networkTx)}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <div className="flex items-center gap-2">
            <Box className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Infrastructure</p>
          </div>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : totals.containers}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {activeApps} apps · {totals.containers} containers
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
                <AreaChart data={points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260 / 40%)" />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number) => [`${v.toFixed(1)}%`, "CPU"]} labelFormatter={(ts: number) => new Date(ts).toLocaleTimeString()} />
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
                <AreaChart data={points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260 / 40%)" />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v)} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number) => [formatBytes(v), "Memory"]} labelFormatter={(ts: number) => new Date(ts).toLocaleTimeString()} />
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
                <AreaChart data={points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260 / 40%)" />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v)} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number, name: string) => [formatBytes(v), name === "networkRx" ? "↓ Received" : "↑ Sent"]} labelFormatter={(ts: number) => new Date(ts).toLocaleTimeString()} />
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
                <AreaChart data={points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.005 260 / 40%)" />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: "oklch(0.5 0.005 260)" }} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v)} />
                  <Tooltip {...chartTooltipStyle} formatter={(v: number) => [formatBytes(v), "Total"]} labelFormatter={(ts: number) => new Date(ts).toLocaleTimeString()} />
                  <Area type="monotone" dataKey="diskTotal" stroke="oklch(0.65 0.1 30)" fill="oklch(0.65 0.1 30 / 15%)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
      </div>
        );
      })()}

      {/* Project list with stats */}
      {displayApps.length === 0 ? (
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
            {displayApps.map((a) => {
              const ps = appStats[a.id];
              const cpu = ps?.containers.reduce((s, c) => s + c.cpuPercent, 0) ?? 0;
              const mem = ps?.containers.reduce((s, c) => s + c.memoryUsage, 0) ?? 0;
              const memLimit = Math.max(0, ...(ps?.containers.map((c) => c.memoryLimit) ?? [0]));
              const netRx = ps?.containers.reduce((s, c) => s + c.networkRx, 0) ?? 0;
              const netTx = ps?.containers.reduce((s, c) => s + c.networkTx, 0) ?? 0;

              const containerCount = ps?.containers.length ?? 0;
              const isActive = a.status === "active";
              const rowLoading = loading && !ps;

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
                    {rowLoading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive ? `${cpu.toFixed(1)}%` : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {rowLoading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive && mem > 0 ? formatBytes(mem) : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {rowLoading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive && (netRx > 0 || netTx > 0) ? (
                      <>{formatBytes(netRx)} / {formatBytes(netTx)}</>
                    ) : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {rowLoading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive && memLimit > 0 ? formatMemLimit(memLimit) : "-"}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {rowLoading ? <Loader2 className="size-3 animate-spin ml-auto" /> : isActive ? containerCount : "-"}
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
