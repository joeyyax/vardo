"use client";

import { useState, useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { Activity, AlertTriangle, Container, Cpu, Microchip, MemoryStick, Network, Loader2, RefreshCw, Thermometer } from "lucide-react";
import { ChartCard } from "@/components/app-status";
import { EmptyState } from "@/components/ui/empty-state";
import { cpuDisplay, formatBytes, formatBytesShort, formatCores, formatCoresShort, formatMemLimit, formatBytesRate, formatTime, type CpuCeiling } from "@/lib/metrics/format";
import { CHART_COLORS, chartTickStyle, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import { networkRates } from "@/lib/metrics/rates";
import { MetricsTooltip } from "@/components/metrics-chart";
import type { ContainerPoint } from "@/lib/metrics/types";
import { useMetricsStream } from "@/hooks/use-metrics-stream";

/** Two points draw a line between two dots — not a trend anyone can read. */
const MIN_CHART_POINTS = 3;
const CHART_HEIGHT = 200;

type AppMetricsProps = {
  orgId: string;
  appId: string;
  environmentName?: string;
  gpuEnabled?: boolean;
  /** Cores the app is capped at, from its own record. Null when uncapped. */
  cpuLimit?: number | null;
};

type ChartPoint = {
  time: string;
  timestamp: number;
  cpu: number;
  memory: number;
  memoryLimit: number;
  networkRx: number;
  networkTx: number;
  networkRxRate: number | null;
  networkTxRate: number | null;
  gpuUtilization: number;
  gpuMemoryUsed: number;
  gpuMemoryTotal: number;
  gpuTemperature: number;
};

/* ── Stable tooltip components (outside render to avoid re-creation) ── */

function CpuTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => formatCores(v)}
      categoryLabels={{ cpu: "CPU" }}
    />
  );
}

function MemTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => formatBytes(v)}
      categoryLabels={{ memory: "Memory" }}
    />
  );
}

function NetTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => formatBytesRate(v)}
      categoryLabels={{ networkRxRate: "RX", networkTxRate: "TX" }}
    />
  );
}

function GpuUtilTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => `${v.toFixed(1)}%`}
      categoryLabels={{ gpuUtilization: "GPU" }}
    />
  );
}

function GpuMemTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => formatBytes(v)}
      categoryLabels={{ gpuMemoryUsed: "GPU Mem" }}
    />
  );
}

function GpuTempTooltip(props: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>; label?: string }) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => `${Math.round(v)}°C`}
      categoryLabels={{ gpuTemperature: "Temp" }}
    />
  );
}

function Skeleton({ className = "w-14" }: { className?: string }) {
  return <span className={`inline-block h-3.5 rounded bg-muted animate-pulse align-middle ${className}`} />;
}

/** Stands in for a chart with too few samples to plot. */
function Collecting({ count }: { count: number }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed"
      style={{ height: CHART_HEIGHT }}
    >
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
      <p className="text-xs text-muted-foreground">Collecting data</p>
      <p className="text-[10px] text-muted-foreground tabular-nums">
        {count} of {MIN_CHART_POINTS} samples
      </p>
    </div>
  );
}

/** Every sample came back empty — a flat line here would be a byte axis over nothing. */
function NoSamples() {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-dashed"
      style={{ height: CHART_HEIGHT }}
    >
      <p className="text-xs text-muted-foreground">No samples in this range</p>
    </div>
  );
}

function ContainerTable({ containers }: { containers: ContainerPoint[] }) {
  return (
    <div className="squircle rounded-lg border bg-card overflow-x-auto">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Container className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Containers</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="text-left font-normal px-4 py-2">Name</th>
            <th className="text-right font-normal px-4 py-2">CPU</th>
            <th className="text-right font-normal px-4 py-2">Memory</th>
            <th className="text-right font-normal px-4 py-2">Limit</th>
            <th className="text-right font-normal px-4 py-2">Net In</th>
            <th className="text-right font-normal px-4 py-2">Net Out</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {containers.map((c) => (
            <tr key={c.containerId}>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-status-success shrink-0" />
                  <span className="font-mono truncate">{c.containerName}</span>
                </div>
              </td>
              <td className="text-right px-4 py-3 tabular-nums text-muted-foreground">{formatCores(c.cpuPercent)}</td>
              <td className="text-right px-4 py-3 tabular-nums text-muted-foreground">{formatBytes(c.memoryUsage)}</td>
              <td className="text-right px-4 py-3 tabular-nums text-muted-foreground">{formatMemLimit(c.memoryLimit)}</td>
              <td className="text-right px-4 py-3 tabular-nums text-muted-foreground">{formatBytes(c.networkRx)}</td>
              <td className="text-right px-4 py-3 tabular-nums text-muted-foreground">{formatBytes(c.networkTx)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AppMetrics({ orgId, appId, environmentName, gpuEnabled, cpuLimit }: AppMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const { points, containers, meta, connected, hasLiveFrame, loading, reconnecting, error } = useMetricsStream({
    historyUrl: `/api/v1/organizations/${orgId}/apps/${appId}/stats/history`,
    streamUrl: `/api/v1/organizations/${orgId}/apps/${appId}/stats/stream${environmentName ? "?environment=" + environmentName : ""}`,
    timeRange,
  });

  // Map MetricsPoint[] to chart-friendly shape with network rates
  const chartData = useMemo<ChartPoint[]>(() => {
    const rates = networkRates(points);
    return points.map((p, i) => ({
      time: formatTime(p.timestamp),
      timestamp: p.timestamp,
      cpu: Math.round(p.cpu * 100) / 100,
      memory: p.memory,
      memoryLimit: p.memoryLimit,
      networkRx: p.networkRx,
      networkTx: p.networkTx,
      networkRxRate: rates[i].networkRxRate,
      networkTxRate: rates[i].networkTxRate,
      gpuUtilization: p.gpuUtilization,
      gpuMemoryUsed: p.gpuMemoryUsed,
      gpuMemoryTotal: p.gpuMemoryTotal,
      gpuTemperature: p.gpuTemperature,
    }));
  }, [points]);

  // Determine if GPU data is actually present in the stream (covers live containers
  // that have GPU even if gpuEnabled flag isn't set on the app record yet)
  const hasGpuData = useMemo(
    () => gpuEnabled || containers.some((c) => c.gpuMemoryTotal > 0),
    [gpuEnabled, containers],
  );

  // Error state -- metrics service unreachable
  if (error && !connected && !loading && points.length === 0) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Metrics unavailable"
        body="Could not connect to the metrics service. This may be a temporary issue."
      />
    );
  }

  // Loading state -- show if still loading history and not connected
  if (loading && !connected) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <Loader2 className="size-6 text-muted-foreground animate-spin" />
        <p className="text-sm text-muted-foreground">Loading metrics...</p>
      </div>
    );
  }

  // No containers running and no history
  if (connected && containers.length === 0 && chartData.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No running containers"
        body="Deploy the app to see resource metrics."
      />
    );
  }

  const latestMemoryLimit = chartData.length > 0 ? chartData[chartData.length - 1].memoryLimit : 0;
  const latestGpuMemTotal = chartData.length > 0 ? chartData[chartData.length - 1].gpuMemoryTotal : 0;

  // Every figure below is zero until the first frame lands — skeleton until it does.
  const awaitingFirstFrame = !hasLiveFrame;
  const sparse = chartData.length < MIN_CHART_POINTS;
  const noSamples = !sparse && chartData.every(
    (p) => p.cpu === 0 && p.memory === 0 && p.networkRx === 0 && p.networkTx === 0,
  );
  const gpuContainers = containers.filter((c) => c.gpuMemoryTotal > 0);
  const tempContainers = containers.filter((c) => c.gpuTemperature > 0);
  const latest = {
    cpu: containers.reduce((s, c) => s + c.cpuPercent, 0),
    memory: containers.reduce((s, c) => s + c.memoryUsage, 0),
    networkRx: containers.reduce((s, c) => s + c.networkRx, 0),
    networkTx: containers.reduce((s, c) => s + c.networkTx, 0),
    gpuUtilization: gpuContainers.length > 0
      ? gpuContainers.reduce((s, c) => s + c.gpuUtilization, 0) / gpuContainers.length
      : 0,
    gpuMemoryUsed: containers.reduce((s, c) => s + c.gpuMemoryUsed, 0),
    gpuTemperature: tempContainers.length > 0
      ? tempContainers.reduce((s, c) => s + c.gpuTemperature, 0) / tempContainers.length
      : 0,
  };

  // The app's own cap when it has one, otherwise the host it shares.
  const hostCores = meta?.cpuCount ?? 0;
  const cpuCeiling: CpuCeiling =
    cpuLimit && cpuLimit > 0
      ? { kind: "enforced", cores: cpuLimit }
      : hostCores > 0
        ? { kind: "capacity", cores: hostCores }
        : { kind: "none" };
  const cpu = cpuDisplay(latest.cpu, cpuCeiling);

  const headerValue = (content: React.ReactNode) =>
    awaitingFirstFrame ? <Skeleton /> : content;

  return (
    <div className="space-y-6">
      {/* Time range + connection status */}
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          {TIME_RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setTimeRange(r.value)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                timeRange === r.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {reconnecting ? (
            <RefreshCw className="size-3 text-status-warning animate-spin" />
          ) : (
            <span className={`size-2 rounded-full ${connected ? "bg-status-success" : "bg-status-neutral"}`} />
          )}
          <span className="text-xs text-muted-foreground">
            {reconnecting ? "Reconnecting..." : connected ? "Live" : "Historical"}
          </span>
        </div>
      </div>

      {/* CPU Chart */}
      <ChartCard title="CPU Usage" icon={Cpu} value={headerValue(cpu.compact)}>
        {sparse ? <Collecting count={chartData.length} /> : noSamples ? <NoSamples /> : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="appCpuGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.cpu} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.cpu} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} />
            <YAxis width={45} tickFormatter={formatCoresShort} tick={chartTickStyle} domain={[0, "auto"]} />
            <Tooltip content={<CpuTooltip />} />
            <Area isAnimationActive={false} type="monotone" dataKey="cpu" stroke={CHART_COLORS.cpu} fill="url(#appCpuGradient)" />
          </AreaChart>
        </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Memory Chart */}
      <ChartCard title="Memory Usage" icon={MemoryStick} value={headerValue(formatBytes(latest.memory))}>
        {latestMemoryLimit > 0 && (
          <p className="text-[10px] text-muted-foreground mb-1" style={{ color: CHART_COLORS.memoryLimit }}>
            Limit: {formatBytes(latestMemoryLimit, 0)}
          </p>
        )}
        {sparse ? <Collecting count={chartData.length} /> : noSamples ? <NoSamples /> : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="appMemGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.memory} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.memory} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} />
            <YAxis
              width={65}
              tickFormatter={formatBytesShort}
              tick={chartTickStyle}
              domain={[0, latestMemoryLimit > 0 ? latestMemoryLimit * 1.1 : "auto"]}
            />
            <Tooltip content={<MemTooltip />} />
            <Area isAnimationActive={false} type="monotone" dataKey="memory" stroke={CHART_COLORS.memory} fill="url(#appMemGradient)" />
          </AreaChart>
        </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Network I/O Chart */}
      <ChartCard
        title="Network I/O"
        icon={Network}
        value={headerValue(`↓ ${formatBytes(latest.networkRx)} · ↑ ${formatBytes(latest.networkTx)}`)}
      >
        {sparse ? <Collecting count={chartData.length} /> : noSamples ? <NoSamples /> : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="appNetRxGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.networkRx} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.networkRx} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="appNetTxGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.networkTx} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.networkTx} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} />
            <YAxis width={75} tickFormatter={(v) => `${formatBytesShort(v)}/s`} tick={chartTickStyle} domain={[0, "auto"]} />
            <Tooltip content={<NetTooltip />} />
            <Area isAnimationActive={false} connectNulls={false} type="monotone" dataKey="networkRxRate" stroke={CHART_COLORS.networkRx} fill="url(#appNetRxGradient)" />
            <Area isAnimationActive={false} connectNulls={false} type="monotone" dataKey="networkTxRate" stroke={CHART_COLORS.networkTx} fill="url(#appNetTxGradient)" />
          </AreaChart>
        </ResponsiveContainer>
        )}
      </ChartCard>

      {/* GPU Charts — only rendered when gpuEnabled or live GPU data present */}
      {hasGpuData && (
        <>
          <ChartCard title="GPU Utilization" icon={Microchip} value={headerValue(`${latest.gpuUtilization.toFixed(1)}%`)}>
            {sparse ? <Collecting count={chartData.length} /> : noSamples ? <NoSamples /> : (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="appGpuUtilGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.gpuUtilization} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={CHART_COLORS.gpuUtilization} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis dataKey="time" tick={chartTickStyle} />
                <YAxis width={45} tickFormatter={(v) => `${v}%`} tick={chartTickStyle} domain={[0, 100]} />
                <Tooltip content={<GpuUtilTooltip />} />
                <Area isAnimationActive={false} type="monotone" dataKey="gpuUtilization" stroke={CHART_COLORS.gpuUtilization} fill="url(#appGpuUtilGradient)" />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard title="GPU Memory" icon={MemoryStick} value={headerValue(formatBytes(latest.gpuMemoryUsed))}>
            {latestGpuMemTotal > 0 && (
              <p className="text-[10px] text-muted-foreground mb-1" style={{ color: CHART_COLORS.memoryLimit }}>
                Total: {formatBytes(latestGpuMemTotal, 0)}
              </p>
            )}
            {sparse ? <Collecting count={chartData.length} /> : noSamples ? <NoSamples /> : (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="appGpuMemGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.gpuMemory} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={CHART_COLORS.gpuMemory} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis dataKey="time" tick={chartTickStyle} />
                <YAxis
                  width={65}
                  tickFormatter={formatBytesShort}
                  tick={chartTickStyle}
                  domain={[0, latestGpuMemTotal > 0 ? latestGpuMemTotal * 1.05 : "auto"]}
                />
                <Tooltip content={<GpuMemTooltip />} />
                <Area isAnimationActive={false} type="monotone" dataKey="gpuMemoryUsed" stroke={CHART_COLORS.gpuMemory} fill="url(#appGpuMemGradient)" />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard
            title="GPU Temperature"
            icon={Thermometer}
            value={headerValue(`${Math.round(latest.gpuTemperature)}°C`)}
          >
            {sparse ? <Collecting count={chartData.length} /> : noSamples ? <NoSamples /> : (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="appGpuTempGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.gpuTemperature} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={CHART_COLORS.gpuTemperature} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis dataKey="time" tick={chartTickStyle} />
                <YAxis width={50} tickFormatter={(v) => `${v}°C`} tick={chartTickStyle} domain={[0, "auto"]} />
                <Tooltip content={<GpuTempTooltip />} />
                <Area isAnimationActive={false} type="monotone" dataKey="gpuTemperature" stroke={CHART_COLORS.gpuTemperature} fill="url(#appGpuTempGradient)" />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </ChartCard>
        </>
      )}

      {/* Container list */}
      {containers.length > 0 ? (
        <ContainerTable containers={containers} />
      ) : awaitingFirstFrame ? (
        <div className="squircle rounded-lg border bg-card">
          <div className="flex items-center gap-2 px-4 py-3 border-b">
            <Container className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Containers</h3>
          </div>
          <div className="divide-y">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3">
                <Skeleton className="w-40" />
                <Skeleton className="w-24" />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
