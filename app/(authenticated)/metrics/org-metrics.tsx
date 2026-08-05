"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, Box, Cpu, HardDrive, MemoryStick, Network, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cpuDisplay, formatBytes, formatBytesShort, formatCores, formatCoresShort, formatMemLimit, formatTime, type CpuCeiling } from "@/lib/metrics/format";
import { CHART_COLORS, chartTickStyle, type TimeRange } from "@/lib/metrics/constants";
import { dedupeByContainer } from "@/lib/metrics/aggregate";
import { networkRates } from "@/lib/metrics/rates";
import { networkBarPoint } from "@/lib/metrics/network-chart";
import { countApps, describeScopeCounts } from "@/lib/metrics/scope";
import {
  DEFAULT_SORT, nextSortDirection, sortAppRows,
  type AppSortKey, type SortDirection,
} from "@/lib/metrics/table-sort";
import { useMetricsStream } from "@/hooks/use-metrics-stream";
import { Sparkline } from "@/components/app-metrics-card";
import { MetricsTooltip } from "@/components/metrics-chart";
import { NetworkChart } from "@/components/network-chart";

type AppSummary = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  parentAppId?: string | null;
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
  parentAppId?: string | null;
  containers: { containerId: string; cpuPercent: number; memoryUsage: number; memoryLimit: number; networkRx: number; networkTx: number }[];
};

/* ── Stable tooltip components (outside render to avoid re-creation) ── */

function CpuTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v: number) => formatCores(v)}
      categoryLabels={{ cpu: "CPU" }}
    />
  );
}

function MemTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v: number) => formatBytes(v)}
      categoryLabels={{ memory: "Memory" }}
    />
  );
}

function DiskTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v: number) => formatBytes(v)}
      categoryLabels={{ diskTotal: "Total" }}
    />
  );
}

/** Stands in for a figure the metrics source never reported. Never render 0 for it. */
function NoValue() {
  return <span className="text-muted-foreground">&mdash;</span>;
}

function Skeleton({ className = "w-12" }: { className?: string }) {
  return <span className={`inline-block h-3.5 rounded bg-muted animate-pulse align-middle ${className}`} />;
}

type SortState = { key: AppSortKey; direction: SortDirection };

function SortHeader({ label, sortKey, sort, onSort, align = "right" }: {
  label: string;
  sortKey: AppSortKey;
  sort: SortState;
  onSort: (next: SortState) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      title={`Sort by ${label.toLowerCase()}`}
      onClick={() => onSort({ key: sortKey, direction: nextSortDirection(sort, sortKey) })}
      className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
        align === "right" ? "justify-end" : "justify-start"
      } ${active ? "text-foreground" : ""}`}
    >
      {label}
      {active && <Arrow className="size-3" />}
    </button>
  );
}

type Slice = { label: string; value: number; color: string; detail?: string };

/** Share of a total: one bar the slices fill, with the total spelled out beside it. */
function ShareBar({ title, subtitle, total, totalLabel, slices, footnote }: {
  title: string; subtitle?: string; total: string; totalLabel: string; slices: Slice[]; footnote?: string;
}) {
  const sum = slices.reduce((s, sl) => s + sl.value, 0);
  return (
    <div className="squircle rounded-lg bg-card shadow-card dark:border overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b">
        <h3 className="text-sm font-medium">{title}</h3>
        {subtitle && <span className="text-[10px] text-muted-foreground text-right">{subtitle}</span>}
      </div>
      <div className="px-4 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="type-numeral text-lg">{total}</span>
          <span className="type-label text-muted-foreground whitespace-nowrap">{totalLabel}</span>
        </div>
        <div className="mt-2 flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted">
          {sum > 0 && slices.map((sl) => (
            <span
              key={sl.label}
              style={{ width: `${(sl.value / sum) * 100}%`, backgroundColor: sl.color }}
            />
          ))}
        </div>
      </div>
      <div className="px-4 py-3 space-y-1">
        {slices.length === 0 && <p className="text-xs text-muted-foreground">Nothing to break down yet.</p>}
        {slices.map((sl) => (
          <div key={sl.label} className="flex items-center justify-between py-0.5">
            <span className="inline-flex items-center gap-1.5 text-xs truncate">
              <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: sl.color }} />
              {sl.label}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground shrink-0 ml-2">
              {sl.detail ?? sl.value}
              {sum > 0 && <span className="ml-1.5 opacity-60">{Math.round((sl.value / sum) * 100)}%</span>}
            </span>
          </div>
        ))}
        {footnote && <p className="pt-1 text-[10px] text-muted-foreground">{footnote}</p>}
      </div>
    </div>
  );
}

export function OrgMetrics({ orgId, apps, projectCount, adminMode }: OrgMetricsProps) {
  const isEmpty = !adminMode && apps.length === 0;
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const historyUrl = adminMode
    ? `/api/v1/admin/stats`
    : `/api/v1/organizations/${orgId}/stats`;
  const streamUrl = adminMode
    ? `/api/v1/admin/stats/stream`
    : `/api/v1/organizations/${orgId}/stats/stream`;

  const { points, meta, connected, hasLiveFrame, loading, reconnecting } = useMetricsStream({
    historyUrl,
    streamUrl,
    timeRange,
  });

  const metaApps = meta?.apps as AppMeta[] | undefined;
  const streamProjectCount = meta?.projectCount as number | undefined;
  const orgDiskTotal = meta?.orgDiskTotal as number | undefined;
  const cpuCores = (meta?.system as { cpus?: number } | null)?.cpus ?? meta?.cpuCount ?? 0;
  // Org scope sums per-app disk; admin scope reports the host's docker usage.
  const diskTotal = orgDiskTotal ?? points[points.length - 1]?.diskTotal ?? 0;
  const scopeNote = adminMode ? "all organizations" : "this organization";

  // Container counts only ever come from the stream; history points don't carry them.
  const containerCountKnown = Boolean(metaApps && metaApps.length > 0);
  const hasSamples = points.length > 0 || containerCountKnown;

  // Grace period so a first paint or a blip isn't an outage. Deferred both
  // ways: setState directly in an effect cascades renders.
  const [streamDown, setStreamDown] = useState(false);
  // Per-app figures are all zero until the first frame — skeletons, not an idle fleet.
  const awaitingFirstFrame = !hasLiveFrame && !streamDown;
  useEffect(() => {
    const live = connected || loading;
    const timer = setTimeout(() => setStreamDown(!live), live ? 0 : 10000);
    return () => clearTimeout(timer);
  }, [connected, loading]);

  // Derive display apps from SSE meta when available, fall back to props
  const displayApps = useMemo(() => {
    if (metaApps && metaApps.length > 0) {
      return metaApps.map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName,
        status: a.status,
        parentAppId: a.parentAppId ?? null,
      }));
    }
    return apps;
  }, [metaApps, apps]);

  const [showIdle, setShowIdle] = useState(false);
  const [sort, setSort] = useState(DEFAULT_SORT);

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

  const scope = useMemo(() => countApps(displayApps), [displayApps]);

  // One row per top-level app. A compose child's containers are reported under
  // its parent's compose project, so a child row can only ever be blank.
  const appRows = useMemo(() => {
    const serviceCounts: Record<string, number> = {};
    for (const a of displayApps) {
      if (a.parentAppId) serviceCounts[a.parentAppId] = (serviceCounts[a.parentAppId] ?? 0) + 1;
    }
    return displayApps
      .filter((a) => !a.parentAppId)
      .map((a) => {
        const containers = appStats[a.id]?.containers ?? [];
        const rx = containers.reduce((s, c) => s + c.networkRx, 0);
        const tx = containers.reduce((s, c) => s + c.networkTx, 0);
        return {
          id: a.id,
          appName: a.name,
          name: a.displayName,
          status: a.status,
          isActive: a.status === "active",
          services: serviceCounts[a.id] ?? 0,
          cpu: containers.reduce((s, c) => s + c.cpuPercent, 0),
          memory: containers.reduce((s, c) => s + c.memoryUsage, 0),
          network: rx + tx,
          networkRx: rx,
          networkTx: tx,
          limit: Math.max(0, ...containers.map((c) => c.memoryLimit), 0),
          containers: containers.length,
        };
      });
  }, [displayApps, appStats]);

  // Running apps carry every number in the table; an idle app is six dashes.
  // Sorted rows first, then the idle tail behind a toggle.
  const [runningApps, idleApps] = useMemo(() => [
    sortAppRows(appRows.filter((a) => a.isActive), sort.key, sort.direction),
    sortAppRows(appRows.filter((a) => !a.isActive), "name", "asc"),
  ], [appRows, sort]);

  // Totals from latest point or from meta apps containers
  const totals = useMemo(() => {
    if (metaApps && metaApps.length > 0) {
      // Each app carries its own breakdown, and a stack child's containers are
      // also listed under its parent — flattening them counts those twice.
      const allContainers = dedupeByContainer(metaApps.map((a) => a.containers));
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

  // Status counts cover top-level apps — the same set /projects lists.
  const statusCounts = useMemo(() => countApps(appRows).byStatus, [appRows]);

  // Nothing caps a whole organization, so the host is the ceiling it competes for.
  const cpuCeiling: CpuCeiling = cpuCores > 0 ? { kind: "capacity", cores: cpuCores } : { kind: "none" };
  const cpu = cpuDisplay(hasSamples ? totals.cpu : null, cpuCeiling);

  // Memoized chart data with network rate computation
  const chartPoints = useMemo(() => {
    const rates = networkRates(points);
    return points.map((p, i) => ({
      ...p,
      time: formatTime(p.timestamp),
      ...networkBarPoint(rates[i]),
    }));
  }, [points]);

  // Memoized sparkline data arrays
  const cpuSparkData = useMemo(() => points.map((p) => p.cpu), [points]);
  const memSparkData = useMemo(() => points.map((p) => p.memory), [points]);
  const diskSparkData = useMemo(() => points.map((p) => p.diskTotal), [points]);
  const netRxSparkData = useMemo(() => points.map((p) => p.networkRx), [points]);
  const netTxSparkData = useMemo(() => points.map((p) => p.networkTx), [points]);

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-12">
        <Activity className="size-8 text-muted-foreground/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No apps deployed yet</p>
          <p className="text-sm text-muted-foreground">
            Deploy an app to start seeing CPU, memory, network, and disk metrics.
          </p>
        </div>
        <Button size="sm" asChild>
          <Link href="/projects">
            <Box className="mr-1.5 size-4" />
            Go to projects
          </Link>
        </Button>
      </div>
    );
  }

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
          {streamDown ? (
            <span className="size-2 rounded-full bg-status-error" />
          ) : reconnecting ? (
            <RefreshCw className="size-3 text-status-warning animate-spin" />
          ) : (
            <span className={`size-2 rounded-full ${loading ? "bg-status-neutral animate-pulse" : connected ? "bg-status-success" : "bg-status-neutral animate-pulse"}`} />
          )}
          <span className="text-xs text-muted-foreground">
            {streamDown ? "Unavailable" : reconnecting ? "Reconnecting..." : connected ? "Live" : loading ? "Loading..." : "Connecting..."}
          </span>
        </div>
      </div>

      {streamDown && (
        <div
          role="alert"
          className="squircle flex items-start gap-3 rounded-lg border border-status-error/30 bg-status-error-muted px-4 py-3"
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5 text-status-error" />
          <div className="space-y-0.5">
            <p className="type-body font-medium">Metrics stream unavailable</p>
            <p className="type-body-sm text-muted-foreground">
              cAdvisor isn&apos;t reachable. Figures below are the last values received.
            </p>
          </div>
        </div>
      )}

      {/* Summary cards with sparklines */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="squircle relative rounded-lg bg-card px-4 py-3 shadow-card dark:border overflow-hidden">
          {points.length > 1 && (
            <Sparkline data={cpuSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.cpu }} />
          )}
          <div className="relative flex items-center gap-2">
            <Cpu className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">CPU</p>
          </div>
          <p className="relative type-numeral text-2xl mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : hasSamples ? cpu.headline : <NoValue />}
          </p>
          <p className="relative text-[10px] text-muted-foreground mt-0.5">
            {cpu.detail ?? `summed across containers · ${scopeNote}`}
          </p>
        </div>
        <div className="squircle relative rounded-lg bg-card px-4 py-3 shadow-card dark:border overflow-hidden">
          {points.length > 1 && (
            <Sparkline data={memSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.memory }} />
          )}
          <div className="relative flex items-center gap-2">
            <MemoryStick className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Memory</p>
          </div>
          <p className="relative type-numeral text-2xl mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : hasSamples ? formatBytes(totals.memory) : <NoValue />}
          </p>
          <p className="relative text-[10px] text-muted-foreground mt-0.5">
            {containerCountKnown
              ? `across ${totals.containers} running container${totals.containers === 1 ? "" : "s"}`
              : `running containers · ${scopeNote}`}
          </p>
        </div>
        <div className="squircle relative rounded-lg bg-card px-4 py-3 shadow-card dark:border overflow-hidden">
          {points.length > 1 && (
            <Sparkline data={diskSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.disk }} />
          )}
          <div className="relative flex items-center gap-2">
            <HardDrive className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Disk</p>
          </div>
          <p className="relative type-numeral text-2xl mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : hasSamples ? formatBytes(diskTotal) : <NoValue />}
          </p>
          {!loading && hasSamples && (
            <p className="relative text-[10px] text-muted-foreground mt-0.5">
              {adminMode
                ? "images, volumes and build cache · whole host"
                : `across ${scope.topLevel} app${scope.topLevel !== 1 ? "s" : ""} in ${scopeNote}`}
            </p>
          )}
        </div>
        <div className="squircle relative rounded-lg bg-card px-4 py-3 shadow-card dark:border overflow-hidden">
          {points.length > 1 && (<>
            <Sparkline data={netRxSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.networkRx }} />
            <Sparkline data={netTxSparkData} className="absolute inset-0 w-full h-full pointer-events-none" style={{ color: CHART_COLORS.networkTx }} />
          </>)}
          <div className="relative flex items-center gap-2">
            <Network className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Bandwidth</p>
          </div>
          <p className="relative type-numeral text-2xl mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : hasSamples ? formatBytes(totals.networkRx + totals.networkTx) : <NoValue />}
          </p>
          {!loading && hasSamples && (
            <p className="relative text-[10px] text-muted-foreground mt-0.5">
              ↑ {formatBytes(totals.networkTx)} sent · ↓ {formatBytes(totals.networkRx)} received
            </p>
          )}
        </div>
        <div className="squircle rounded-lg bg-card px-4 py-3 shadow-card dark:border">
          <div className="flex items-center gap-2">
            <Box className="size-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">Containers</p>
          </div>
          <p className="type-numeral text-2xl mt-1">
            {loading ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : containerCountKnown ? totals.containers : <NoValue />}
          </p>
          {/* App counts live in the Apps breakdown below — a container count and an
              app count never match, and side by side they read as one figure. */}
          <p className="text-[10px] text-muted-foreground mt-0.5">
            reporting to cAdvisor now · {scopeNote}
          </p>
        </div>
      </div>

      {/* Aggregate charts */}
      <div className="grid md:grid-cols-2 gap-4">
          <div className="squircle rounded-lg bg-card shadow-card dark:border overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Cpu className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">CPU</h3>
              <span className="text-[10px] text-muted-foreground">cores</span>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartPoints}>
                  <defs>
                    <linearGradient id="orgCpuGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS.cpu} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={CHART_COLORS.cpu} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                  <XAxis dataKey="time" tick={chartTickStyle} />
                  <YAxis width={45} tickFormatter={formatCoresShort} tick={chartTickStyle} />
                  <Tooltip content={<CpuTooltip />} />
                  <Area isAnimationActive={false} type="monotone" dataKey="cpu" stroke={CHART_COLORS.cpu} fill="url(#orgCpuGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="squircle rounded-lg bg-card shadow-card dark:border overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <MemoryStick className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Memory</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartPoints}>
                  <defs>
                    <linearGradient id="orgMemGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS.memory} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={CHART_COLORS.memory} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                  <XAxis dataKey="time" tick={chartTickStyle} />
                  <YAxis width={65} tickFormatter={formatBytesShort} tick={chartTickStyle} />
                  <Tooltip content={<MemTooltip />} />
                  <Area isAnimationActive={false} type="monotone" dataKey="memory" stroke={CHART_COLORS.memory} fill="url(#orgMemGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="squircle rounded-lg bg-card shadow-card dark:border overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Network className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Network</h3>
            </div>
            <div className="p-4">
              <NetworkChart data={chartPoints} height={180} />
            </div>
          </div>
          <div className="squircle rounded-lg bg-card shadow-card dark:border overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <HardDrive className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Disk Usage</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartPoints}>
                  <defs>
                    <linearGradient id="orgDiskGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS.disk} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={CHART_COLORS.disk} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                  <XAxis dataKey="time" tick={chartTickStyle} />
                  <YAxis width={65} tickFormatter={formatBytesShort} tick={chartTickStyle} />
                  <Tooltip content={<DiskTooltip />} />
                  <Area isAnimationActive={false} type="monotone" dataKey="diskTotal" stroke={CHART_COLORS.disk} fill="url(#orgDiskGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
      </div>

      {/* Infrastructure overview — share-of-total bars, table below */}
      {(() => {
        const MAX_SLICES = 8;
        const appColors = [
          CHART_COLORS.cpu, CHART_COLORS.memory, CHART_COLORS.networkRx, CHART_COLORS.networkTx,
          "oklch(0.65 0.16 335)", "oklch(0.68 0.16 175)", "oklch(0.65 0.18 290)", "oklch(0.67 0.17 120)",
        ];

        const statusSlices = [
          { label: "Running", value: statusCounts.active, color: "var(--color-status-success, #22c55e)" },
          { label: "Deploying", value: statusCounts.deploying, color: "var(--color-status-info, #3b82f6)" },
          { label: "Crashed", value: statusCounts.error, color: "var(--color-status-error, #ef4444)" },
          { label: "No container", value: statusCounts.missing, color: "var(--color-status-warning, #f59e0b)" },
          { label: "Stopped", value: statusCounts.stopped, color: "oklch(0.5 0 0 / 30%)" },
        ].filter((s) => s.value > 0);

        const allActive = runningApps
          .filter((a) => a.memory > 0)
          .map((a) => ({ name: a.name, cpu: a.cpu, memory: a.memory, network: a.network }));

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

        return (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <ShareBar
              title="Apps"
              subtitle={`${scopeNote} · ${streamProjectCount ?? projectCount ?? 0} projects`}
              total={`${scope.topLevel} app${scope.topLevel === 1 ? "" : "s"}`}
              totalLabel="top-level"
              slices={statusSlices}
              footnote={scope.composeServices > 0
                ? `${describeScopeCounts(scope)} = ${scope.total} app records`
                : undefined}
            />
            <ShareBar
              title="CPU"
              subtitle="by app"
              total={formatCores(totals.cpu)}
              totalLabel={cpuCores > 0 ? `of ${cpuCores} cores` : "total"}
              slices={cpuApps.map((a, i) => ({ label: a.name, value: a.cpu, color: appColors[i % appColors.length], detail: formatCores(a.cpu) }))}
            />
            <ShareBar
              title="Memory"
              subtitle="by app"
              total={formatBytes(totals.memory)}
              totalLabel="total"
              slices={memApps.map((a, i) => ({ label: a.name, value: a.memory, color: appColors[i % appColors.length], detail: formatBytes(a.memory) }))}
            />
            <ShareBar
              title="Network"
              subtitle="by app · since container start"
              total={formatBytes(totals.networkRx + totals.networkTx)}
              totalLabel="total"
              slices={netApps.map((a, i) => ({ label: a.name, value: a.network, color: appColors[i % appColors.length], detail: formatBytes(a.network) }))}
            />
          </div>
        );
      })()}

      {/* Per-app stats */}
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
              Go to projects
            </Link>
          </Button>
        </div>
      ) : (
        <div className="squircle rounded-lg bg-card shadow-card dark:border overflow-x-auto">
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b">
            <h3 className="text-sm font-medium">Apps</h3>
            <span className="text-[10px] text-muted-foreground">
              top-level apps in {scopeNote}
              {scope.composeServices > 0 && ` · compose services counted on their parent`}
            </span>
          </div>
          {/* Header */}
          <div className="grid grid-cols-[1fr_90px_90px_100px_80px_80px] gap-3 px-4 py-2 border-b text-xs text-muted-foreground whitespace-nowrap min-w-[720px]">
            <SortHeader label="App" sortKey="name" sort={sort} onSort={setSort} align="left" />
            <SortHeader label="CPU" sortKey="cpu" sort={sort} onSort={setSort} />
            <SortHeader label="Memory" sortKey="memory" sort={sort} onSort={setSort} />
            <SortHeader label="Network" sortKey="network" sort={sort} onSort={setSort} />
            <SortHeader label="Limit" sortKey="limit" sort={sort} onSort={setSort} />
            <SortHeader label="Containers" sortKey="containers" sort={sort} onSort={setSort} />
          </div>
          <div className="divide-y">
            {(showIdle ? [...runningApps, ...idleApps] : runningApps).map((a) => {
              const cell = (content: React.ReactNode) => (
                awaitingFirstFrame ? <Skeleton className="w-10" /> : a.isActive ? content : "-"
              );

              return (
                <Link
                  key={a.id}
                  href={`/apps/${a.appName}/metrics`}
                  className="grid grid-cols-[1fr_90px_90px_100px_80px_80px] gap-3 px-4 py-3 hover:bg-accent/50 transition-colors items-center whitespace-nowrap min-w-[720px]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`size-2 rounded-full shrink-0 ${
                        a.isActive ? "bg-status-success" : "bg-status-neutral"
                      }`}
                    />
                    <span className="text-sm font-medium truncate">{a.name}</span>
                    {a.services > 0 && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        +{a.services} service{a.services !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {cell(formatCores(a.cpu))}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {cell(a.memory > 0 ? formatBytes(a.memory) : "-")}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {cell(a.network > 0 ? `${formatBytes(a.networkRx)} / ${formatBytes(a.networkTx)}` : "-")}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {cell(a.limit > 0 ? formatMemLimit(a.limit) : "-")}
                  </span>
                  <span className="text-xs text-right tabular-nums text-muted-foreground">
                    {cell(a.containers)}
                  </span>
                </Link>
              );
            })}
          </div>
          {runningApps.length === 0 && !showIdle && (
            <p className="px-4 py-3 text-xs text-muted-foreground">No apps running.</p>
          )}
          {idleApps.length > 0 && (
            <button
              onClick={() => setShowIdle((v) => !v)}
              className="w-full border-t px-4 py-2.5 text-left text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
            >
              {showIdle
                ? `Hide ${idleApps.length} not running`
                : `Show ${idleApps.length} not running`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
