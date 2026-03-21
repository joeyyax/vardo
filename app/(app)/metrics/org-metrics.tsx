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
  projectCount?: number;
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

export function OrgMetrics({ orgId, apps, projectCount, adminMode }: OrgMetricsProps) {
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
  const streamProjectCount = meta?.projectCount as number | undefined;

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

  const statusCounts = useMemo(() => {
    const counts = { active: 0, stopped: 0, error: 0, deploying: 0 };
    for (const app of displayApps) {
      if (app.status in counts) counts[app.status as keyof typeof counts]++;
    }
    return counts;
  }, [displayApps]);

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
          {points.length > 1 && (<>
            <Sparkline data={points.map((p) => p.networkRx)} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.networkRx }} />
            <Sparkline data={points.map((p) => p.networkTx)} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.networkTx }} />
          </>)}
          <div className="relative flex items-center gap-2">
            <Network className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Bandwidth</p>
          </div>
          <p className="relative text-2xl font-semibold tabular-nums mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : formatBytes(totals.networkRx + totals.networkTx)}
          </p>
          {!loading && (
            <p className="relative text-[10px] text-muted-foreground mt-0.5">
              ↓ {formatBytes(totals.networkRx)} · ↑ {formatBytes(totals.networkTx)}
            </p>
          )}
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <div className="flex items-center gap-2">
            <Box className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Containers</p>
          </div>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : totals.containers}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {statusCounts.active > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-status-success">
                <span className="size-1.5 rounded-full bg-status-success" />
                {statusCounts.active} running
              </span>
            )}
            {statusCounts.error > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-status-error">
                <span className="size-1.5 rounded-full bg-status-error" />
                {statusCounts.error} crashed
              </span>
            )}
            {statusCounts.stopped > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-status-neutral" />
                {statusCounts.stopped} stopped
              </span>
            )}
            {statusCounts.deploying > 0 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-status-info">
                <span className="size-1.5 rounded-full bg-status-info animate-pulse" />
                {statusCounts.deploying} deploying
              </span>
            )}
          </div>
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

      {/* Infrastructure overview — half donuts + tables */}
      {(() => {
        // App status donut data
        const statusSlices = [
          { label: "Running", count: statusCounts.active, color: "var(--color-status-success, #22c55e)" },
          { label: "Deploying", count: statusCounts.deploying, color: "var(--color-status-info, #3b82f6)" },
          { label: "Crashed", count: statusCounts.error, color: "var(--color-status-error, #ef4444)" },
          { label: "Stopped", count: statusCounts.stopped, color: "oklch(0.5 0 0 / 30%)" },
        ].filter((s) => s.count > 0);
        const totalAppsCount = displayApps.length;

        // Resource donut data — memory share per app
        const MAX_DONUT_SLICES = 8;
        const allActiveApps = displayApps
          .filter((a) => a.status === "active")
          .map((a) => {
            const ps = appStats[a.id];
            return {
              name: a.displayName,
              cpu: ps?.containers.reduce((s, c) => s + c.cpuPercent, 0) ?? 0,
              memory: ps?.containers.reduce((s, c) => s + c.memoryUsage, 0) ?? 0,
              containerCount: ps?.containers.length ?? 0,
            };
          })
          .filter((a) => a.memory > 0)
          .sort((a, b) => b.memory - a.memory);

        const activeAppsData = allActiveApps.length > MAX_DONUT_SLICES
          ? [
              ...allActiveApps.slice(0, MAX_DONUT_SLICES - 1),
              {
                name: `${allActiveApps.length - MAX_DONUT_SLICES + 1} others`,
                cpu: allActiveApps.slice(MAX_DONUT_SLICES - 1).reduce((s, a) => s + a.cpu, 0),
                memory: allActiveApps.slice(MAX_DONUT_SLICES - 1).reduce((s, a) => s + a.memory, 0),
                containerCount: allActiveApps.slice(MAX_DONUT_SLICES - 1).reduce((s, a) => s + a.containerCount, 0),
              },
            ]
          : allActiveApps;

        const appColors = [
          CHART_COLORS.cpu,
          CHART_COLORS.memory,
          CHART_COLORS.networkRx,
          CHART_COLORS.networkTx,
          "oklch(0.65 0.16 335)",
          "oklch(0.68 0.16 175)",
          "oklch(0.65 0.18 290)",
          "oklch(0.67 0.17 120)",
        ];

        return (
          <div className="grid md:grid-cols-2 gap-4">
            {/* App Status — half donut + table */}
            <div className="squircle rounded-lg border bg-card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <h3 className="text-sm font-medium">App Status</h3>
                <span className="text-xs text-muted-foreground">{streamProjectCount ?? projectCount ?? 0} projects</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-6">
                  {/* Half donut SVG */}
                  <svg viewBox="0 0 120 70" className="w-32 shrink-0">
                    {(() => {
                      const r = 50;
                      const cx = 60;
                      const cy = 60;
                      const total = totalAppsCount || 1;
                      let cumAngle = Math.PI; // start from left (180°)
                      return statusSlices.map((slice) => {
                        const angle = (slice.count / total) * Math.PI;
                        const startX = cx + r * Math.cos(cumAngle);
                        const startY = cy + r * Math.sin(cumAngle);
                        cumAngle += angle;
                        const endX = cx + r * Math.cos(cumAngle);
                        const endY = cy + r * Math.sin(cumAngle);
                        const largeArc = angle > Math.PI ? 1 : 0;
                        return (
                          <path
                            key={slice.label}
                            d={`M ${cx} ${cy} L ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY} Z`}
                            fill={slice.color}
                            opacity={0.85}
                          />
                        );
                      });
                    })()}
                    <text x="60" y="58" textAnchor="middle" fill="currentColor" fontSize="22" fontWeight="600">
                      {totalAppsCount}
                    </text>
                    <text x="60" y="68" textAnchor="middle" fill="currentColor" opacity={0.5} fontSize="8">
                      apps
                    </text>
                  </svg>
                  {/* Legend table */}
                  <div className="flex-1 space-y-1.5">
                    {statusSlices.map((slice) => (
                      <div key={slice.label} className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: slice.color }} />
                          {slice.label}
                        </span>
                        <span className="text-xs font-semibold tabular-nums">{slice.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Resource distribution — half donut + table */}
            <div className="squircle rounded-lg border bg-card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <h3 className="text-sm font-medium">Memory by App</h3>
                <span className="text-xs text-muted-foreground">{totals.containers} containers</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-6">
                  {/* Half donut SVG */}
                  <svg viewBox="0 0 120 70" className="w-32 shrink-0">
                    {(() => {
                      const r = 50;
                      const cx = 60;
                      const cy = 60;
                      const total = totals.memory || 1;
                      let cumAngle = Math.PI;
                      return activeAppsData.map((app, i) => {
                        const angle = (app.memory / total) * Math.PI;
                        const startX = cx + r * Math.cos(cumAngle);
                        const startY = cy + r * Math.sin(cumAngle);
                        cumAngle += angle;
                        const endX = cx + r * Math.cos(cumAngle);
                        const endY = cy + r * Math.sin(cumAngle);
                        const largeArc = angle > Math.PI ? 1 : 0;
                        return (
                          <path
                            key={app.name}
                            d={`M ${cx} ${cy} L ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY} Z`}
                            fill={appColors[i % appColors.length]}
                            opacity={0.85}
                          />
                        );
                      });
                    })()}
                    <text x="60" y="58" textAnchor="middle" fill="currentColor" fontSize="14" fontWeight="600">
                      {loading ? "..." : formatBytes(totals.memory)}
                    </text>
                  </svg>
                  {/* Legend table */}
                  <div className="flex-1 space-y-1.5">
                    {activeAppsData.map((app, i) => (
                      <div key={app.name} className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-xs truncate">
                          <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: appColors[i % appColors.length] }} />
                          {app.name}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground shrink-0 ml-2">{formatBytes(app.memory)}</span>
                      </div>
                    ))}
                    {activeAppsData.length === 0 && (
                      <p className="text-xs text-muted-foreground">No active apps</p>
                    )}
                  </div>
                </div>
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
