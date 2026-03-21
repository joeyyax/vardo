"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Activity, Box, Cpu, HardDrive, MemoryStick, Network, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AreaChart } from "@tremor/react";
import type { CustomTooltipProps } from "@tremor/react";
import { formatBytes, formatMemLimit, formatTime } from "@/lib/metrics/format";
import { CHART_COLORS, type TimeRange } from "@/lib/metrics/constants";
import { useMetricsStream } from "@/lib/hooks/use-metrics-stream";
import { Sparkline } from "@/components/app-metrics-card";
import { TREMOR_METRIC_COLORS, MetricsTooltip } from "@/components/metrics-chart";
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

/* ── Stable tooltip components (outside render to avoid re-creation) ── */

function CpuTooltip(props: CustomTooltipProps) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v: number) => `${v.toFixed(1)}%`}
      categoryLabels={{ cpu: "CPU" }}
    />
  );
}

function MemTooltip(props: CustomTooltipProps) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v: number) => formatBytes(v)}
      categoryLabels={{ memory: "Memory" }}
    />
  );
}

function NetTooltip(props: CustomTooltipProps) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v: number) => formatBytes(v)}
      categoryLabels={{ networkRx: "\u2193 Received", networkTx: "\u2191 Sent" }}
    />
  );
}

function DiskTooltip(props: CustomTooltipProps) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v: number) => formatBytes(v)}
      categoryLabels={{ diskTotal: "Total" }}
    />
  );
}

export function OrgMetrics({ orgId, apps, projectCount, adminMode }: OrgMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

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

  // Memoized chart data
  const chartPoints = useMemo(
    () => points.map((p) => ({ ...p, time: formatTime(p.timestamp) })),
    [points],
  );

  // Memoized sparkline data arrays
  const cpuSparkData = useMemo(() => points.map((p) => p.cpu), [points]);
  const memSparkData = useMemo(() => points.map((p) => p.memory), [points]);
  const diskSparkData = useMemo(() => points.map((p) => p.diskTotal), [points]);
  const netRxSparkData = useMemo(() => points.map((p) => p.networkRx), [points]);
  const netTxSparkData = useMemo(() => points.map((p) => p.networkTx), [points]);

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
            <Sparkline data={cpuSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.cpu }} />
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
            <Sparkline data={memSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.memory }} />
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
            <Sparkline data={diskSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.disk }} />
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
            <Sparkline data={netRxSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.networkRx }} />
            <Sparkline data={netTxSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.networkTx }} />
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
      <div className="grid md:grid-cols-2 gap-4">
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Cpu className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">CPU</h3>
            </div>
            <div className="p-4">
              <AreaChart
                className="h-[180px]"
                data={chartPoints}
                index="time"
                categories={["cpu"]}
                colors={[TREMOR_METRIC_COLORS.cpu]}
                valueFormatter={(v) => `${v.toFixed(1)}%`}
                showLegend={false}
                showAnimation={false}
                curveType="monotone"
                customTooltip={CpuTooltip}
              />
            </div>
          </div>
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <MemoryStick className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Memory</h3>
            </div>
            <div className="p-4">
              <AreaChart
                className="h-[180px]"
                data={chartPoints}
                index="time"
                categories={["memory"]}
                colors={[TREMOR_METRIC_COLORS.memory]}
                valueFormatter={(v) => formatBytes(v)}
                showLegend={false}
                showAnimation={false}
                curveType="monotone"
                customTooltip={MemTooltip}
              />
            </div>
          </div>
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Network className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Network</h3>
            </div>
            <div className="p-4">
              <AreaChart
                className="h-[180px]"
                data={chartPoints}
                index="time"
                categories={["networkRx", "networkTx"]}
                colors={[TREMOR_METRIC_COLORS.networkRx, TREMOR_METRIC_COLORS.networkTx]}
                valueFormatter={(v) => formatBytes(v)}
                showLegend={false}
                showAnimation={false}
                curveType="monotone"
                customTooltip={NetTooltip}
              />
            </div>
          </div>
          <div className="squircle rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <HardDrive className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Disk Usage</h3>
            </div>
            <div className="p-4">
              <AreaChart
                className="h-[180px]"
                data={chartPoints}
                index="time"
                categories={["diskTotal"]}
                colors={[TREMOR_METRIC_COLORS.diskTotal]}
                valueFormatter={(v) => formatBytes(v)}
                showLegend={false}
                showAnimation={false}
                curveType="monotone"
                customTooltip={DiskTooltip}
              />
            </div>
          </div>
      </div>

      {/* Infrastructure overview — half donuts on top, tables below */}
      {(() => {
        const MAX_SLICES = 8;
        const appColors = [
          CHART_COLORS.cpu, CHART_COLORS.memory, CHART_COLORS.networkRx, CHART_COLORS.networkTx,
          "oklch(0.65 0.16 335)", "oklch(0.68 0.16 175)", "oklch(0.65 0.18 290)", "oklch(0.67 0.17 120)",
        ];

        // Status donut
        const statusSlices = [
          { label: "Running", value: statusCounts.active, color: "var(--color-status-success, #22c55e)" },
          { label: "Deploying", value: statusCounts.deploying, color: "var(--color-status-info, #3b82f6)" },
          { label: "Crashed", value: statusCounts.error, color: "var(--color-status-error, #ef4444)" },
          { label: "Stopped", value: statusCounts.stopped, color: "oklch(0.5 0 0 / 30%)" },
        ].filter((s) => s.value > 0);

        // Per-app resource data
        const allActive = displayApps
          .filter((a) => a.status === "active")
          .map((a) => {
            const ps = appStats[a.id];
            const containers = ps?.containers || [];
            return {
              name: a.displayName,
              cpu: containers.reduce((s, c) => s + c.cpuPercent, 0),
              memory: containers.reduce((s, c) => s + c.memoryUsage, 0),
              network: containers.reduce((s, c) => s + c.networkRx + c.networkTx, 0),
            };
          })
          .filter((a) => a.memory > 0);

        function topN(items: typeof allActive, key: "cpu" | "memory" | "network") {
          const sorted = [...items].sort((a, b) => b[key] - a[key]);
          if (sorted.length <= MAX_SLICES) return sorted;
          const top = sorted.slice(0, MAX_SLICES - 1);
          const rest = sorted.slice(MAX_SLICES - 1);
          top.push({
            name: `${rest.length} others`,
            cpu: rest.reduce((s, a) => s + a.cpu, 0),
            memory: rest.reduce((s, a) => s + a.memory, 0),
            network: rest.reduce((s, a) => s + a.network, 0),
          });
          return top;
        }

        const memApps = topN(allActive, "memory");
        const cpuApps = topN(allActive, "cpu");
        const netApps = topN(allActive, "network");

        type Slice = { label: string; value: number; color: string; detail?: string };

        function HalfDonut({ title, subtitle, slices, centerLabel, centerSub }: {
          title: string; subtitle?: string; slices: Slice[]; centerLabel: string; centerSub?: string;
        }) {
          const total = slices.reduce((s, sl) => s + sl.value, 0) || 1;
          return (
            <div className="squircle rounded-lg border bg-card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b">
                <h3 className="text-sm font-medium">{title}</h3>
                {subtitle && <span className="text-[10px] text-muted-foreground">{subtitle}</span>}
              </div>
              <div className="flex justify-center pt-4 pb-2">
                <svg viewBox="0 0 120 68" className="w-28">
                  {(() => {
                    const r = 48, cx = 60, cy = 58;
                    let a = Math.PI;
                    return slices.map((sl) => {
                      const ang = (sl.value / total) * Math.PI;
                      const x1 = cx + r * Math.cos(a), y1 = cy + r * Math.sin(a);
                      a += ang;
                      const x2 = cx + r * Math.cos(a), y2 = cy + r * Math.sin(a);
                      return (
                        <path key={sl.label} d={`M${cx} ${cy}L${x1} ${y1}A${r} ${r} 0 ${ang > Math.PI ? 1 : 0} 1 ${x2} ${y2}Z`}
                          fill={sl.color} opacity={0.85} />
                      );
                    });
                  })()}
                  <text x="60" y="52" textAnchor="middle" fill="currentColor" fontSize="16" fontWeight="600">{centerLabel}</text>
                  {centerSub && <text x="60" y="63" textAnchor="middle" fill="currentColor" opacity={0.5} fontSize="8">{centerSub}</text>}
                </svg>
              </div>
              <div className="px-4 pb-3 space-y-1">
                {slices.map((sl) => (
                  <div key={sl.label} className="flex items-center justify-between py-0.5">
                    <span className="inline-flex items-center gap-1.5 text-xs truncate">
                      <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: sl.color }} />
                      {sl.label}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground shrink-0 ml-2">
                      {sl.detail ?? sl.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        }

        return (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <HalfDonut
              title="Status"
              subtitle={`${streamProjectCount ?? projectCount ?? 0} projects`}
              slices={statusSlices}
              centerLabel={String(displayApps.length)}
              centerSub="apps"
            />
            <HalfDonut
              title="CPU"
              subtitle="by app"
              slices={cpuApps.map((a, i) => ({ label: a.name, value: a.cpu, color: appColors[i % appColors.length], detail: `${a.cpu.toFixed(1)}%` }))}
              centerLabel={`${totals.cpu.toFixed(1)}%`}
            />
            <HalfDonut
              title="Memory"
              subtitle="by app"
              slices={memApps.map((a, i) => ({ label: a.name, value: a.memory, color: appColors[i % appColors.length], detail: formatBytes(a.memory) }))}
              centerLabel={formatBytes(totals.memory)}
            />
            <HalfDonut
              title="Network"
              subtitle="by app"
              slices={netApps.map((a, i) => ({ label: a.name, value: a.network, color: appColors[i % appColors.length], detail: formatBytes(a.network) }))}
              centerLabel={formatBytes(totals.networkRx + totals.networkTx)}
            />
          </div>
        );
      })()}

      {/* Project list with stats */}
      {displayApps.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
          <Activity className="size-8 text-muted-foreground/50" />
          <div className="text-center space-y-1">
            <p className="text-sm font-medium">Metrics will appear here</p>
            <p className="text-sm text-muted-foreground">
              Deploy your first app to see CPU, memory, network, and disk usage across your infrastructure.
            </p>
          </div>
          <Button size="sm" asChild>
            <Link href="/projects">
              <Box className="mr-1.5 size-4" />
              Go to Projects
            </Link>
          </Button>
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
