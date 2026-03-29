"use client";

import { useState, useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { Activity, AlertTriangle, Container, Cpu, Microchip, MemoryStick, Network, Loader2, RefreshCw, Thermometer } from "lucide-react";
import { ChartCard } from "@/components/app-status";
import { formatBytes, formatBytesShort, formatMemLimit, formatBytesRate, formatTime } from "@/lib/metrics/format";
import { CHART_COLORS, chartTickStyle, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import { MetricsTooltip } from "@/components/metrics-chart";
import type { ContainerPoint } from "@/lib/metrics/types";
import { useMetricsStream } from "@/hooks/use-metrics-stream";

type AppMetricsProps = {
  orgId: string;
  appId: string;
  environmentName?: string;
  gpuEnabled?: boolean;
};

type ChartPoint = {
  time: string;
  timestamp: number;
  cpu: number;
  memory: number;
  memoryLimit: number;
  networkRx: number;
  networkTx: number;
  networkRxRate: number;
  networkTxRate: number;
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
      valueFormatter={(v) => `${v.toFixed(2)}%`}
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
              <td className="text-right px-4 py-3 tabular-nums text-muted-foreground">{c.cpuPercent.toFixed(1)}%</td>
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

export function AppMetrics({ orgId, appId, environmentName, gpuEnabled }: AppMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const { points, containers, connected, loading, reconnecting, error } = useMetricsStream({
    historyUrl: `/api/v1/organizations/${orgId}/apps/${appId}/stats/history`,
    streamUrl: `/api/v1/organizations/${orgId}/apps/${appId}/stats/stream${environmentName ? "?environment=" + environmentName : ""}`,
    timeRange,
  });

  // Map MetricsPoint[] to chart-friendly shape with network rates
  const chartData = useMemo<ChartPoint[]>(() => {
    return points.map((p, i) => {
      let networkRxRate = 0;
      let networkTxRate = 0;

      if (i > 0) {
        const prev = points[i - 1];
        const dtSec = (p.timestamp - prev.timestamp) / 1000;
        if (dtSec > 0) {
          const rxDelta = p.networkRx - prev.networkRx;
          const txDelta = p.networkTx - prev.networkTx;
          networkRxRate = Math.max(0, rxDelta / dtSec);
          networkTxRate = Math.max(0, txDelta / dtSec);
        }
      }

      return {
        time: formatTime(p.timestamp),
        timestamp: p.timestamp,
        cpu: Math.round(p.cpu * 100) / 100,
        memory: p.memory,
        memoryLimit: p.memoryLimit,
        networkRx: p.networkRx,
        networkTx: p.networkTx,
        networkRxRate,
        networkTxRate,
        gpuUtilization: p.gpuUtilization,
        gpuMemoryUsed: p.gpuMemoryUsed,
        gpuMemoryTotal: p.gpuMemoryTotal,
        gpuTemperature: p.gpuTemperature,
      };
    });
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
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <AlertTriangle className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Metrics unavailable</p>
        <p className="text-xs text-muted-foreground max-w-xs text-center">
          Could not connect to the metrics service. This may be a temporary issue.
        </p>
      </div>
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
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <Activity className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No running containers.</p>
        <p className="text-xs text-muted-foreground">
          Deploy the app to see resource metrics.
        </p>
      </div>
    );
  }

  const latestMemoryLimit = chartData.length > 0 ? chartData[chartData.length - 1].memoryLimit : 0;
  const latestGpuMemTotal = chartData.length > 0 ? chartData[chartData.length - 1].gpuMemoryTotal : 0;

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

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">CPU Usage</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {containers.reduce((s, c) => s + c.cpuPercent, 0).toFixed(1)}%
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Memory</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {formatBytes(containers.reduce((s, c) => s + c.memoryUsage, 0))}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Network RX</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {formatBytes(containers.reduce((s, c) => s + c.networkRx, 0))}
          </p>
        </div>
        <div className="squircle rounded-lg border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Network TX</p>
          <p className="text-2xl font-semibold tabular-nums mt-1">
            {formatBytes(containers.reduce((s, c) => s + c.networkTx, 0))}
          </p>
        </div>
      </div>
      {hasGpuData && (
        <div className={`grid grid-cols-2 gap-4 ${containers.some((c) => c.gpuTemperature > 0) ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
          <div className="squircle rounded-lg border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">GPU</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">
              {(() => {
                const gpuContainers = containers.filter((c) => c.gpuMemoryTotal > 0);
                return gpuContainers.length > 0
                  ? (gpuContainers.reduce((s, c) => s + c.gpuUtilization, 0) / gpuContainers.length).toFixed(1)
                  : "0.0";
              })()}%
            </p>
          </div>
          <div className="squircle rounded-lg border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">GPU Memory</p>
            <p className="text-2xl font-semibold tabular-nums mt-1">
              {formatBytes(containers.reduce((s, c) => s + c.gpuMemoryUsed, 0))}
            </p>
          </div>
          {containers.some((c) => c.gpuTemperature > 0) && (
            <div className="squircle rounded-lg border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">GPU Temp</p>
              <p className="text-2xl font-semibold tabular-nums mt-1">
                {Math.round(
                  containers.filter((c) => c.gpuTemperature > 0).reduce((s, c) => s + c.gpuTemperature, 0) /
                  Math.max(1, containers.filter((c) => c.gpuTemperature > 0).length)
                )}°C
              </p>
            </div>
          )}
        </div>
      )}

      {/* CPU Chart */}
      <ChartCard title="CPU Usage" icon={Cpu}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="appCpuGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.cpu} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.cpu} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} />
            <YAxis width={45} tickFormatter={(v) => `${v}%`} tick={chartTickStyle} />
            <Tooltip content={<CpuTooltip />} />
            <Area isAnimationActive={false} type="monotone" dataKey="cpu" stroke={CHART_COLORS.cpu} fill="url(#appCpuGradient)" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Memory Chart */}
      <ChartCard title="Memory Usage" icon={MemoryStick}>
        {latestMemoryLimit > 0 && (
          <p className="text-[10px] text-muted-foreground mb-1" style={{ color: CHART_COLORS.memoryLimit }}>
            Limit: {formatBytes(latestMemoryLimit, 0)}
          </p>
        )}
        <ResponsiveContainer width="100%" height={200}>
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
      </ChartCard>

      {/* Network I/O Chart */}
      <ChartCard title="Network I/O" icon={Network}>
        <ResponsiveContainer width="100%" height={200}>
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
            <YAxis width={75} tickFormatter={(v) => `${formatBytesShort(v)}/s`} tick={chartTickStyle} />
            <Tooltip content={<NetTooltip />} />
            <Area isAnimationActive={false} type="monotone" dataKey="networkRxRate" stroke={CHART_COLORS.networkRx} fill="url(#appNetRxGradient)" />
            <Area isAnimationActive={false} type="monotone" dataKey="networkTxRate" stroke={CHART_COLORS.networkTx} fill="url(#appNetTxGradient)" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* GPU Charts — only rendered when gpuEnabled or live GPU data present */}
      {hasGpuData && (
        <>
          <ChartCard title="GPU Utilization" icon={Microchip}>
            <ResponsiveContainer width="100%" height={200}>
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
          </ChartCard>

          <ChartCard title="GPU Memory" icon={MemoryStick}>
            {latestGpuMemTotal > 0 && (
              <p className="text-[10px] text-muted-foreground mb-1" style={{ color: CHART_COLORS.memoryLimit }}>
                Total: {formatBytes(latestGpuMemTotal, 0)}
              </p>
            )}
            <ResponsiveContainer width="100%" height={200}>
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
          </ChartCard>

          <ChartCard title="GPU Temperature" icon={Thermometer}>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="appGpuTempGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS.gpuTemperature} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={CHART_COLORS.gpuTemperature} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis dataKey="time" tick={chartTickStyle} />
                <YAxis width={50} tickFormatter={(v) => `${v}°C`} tick={chartTickStyle} />
                <Tooltip content={<GpuTempTooltip />} />
                <Area isAnimationActive={false} type="monotone" dataKey="gpuTemperature" stroke={CHART_COLORS.gpuTemperature} fill="url(#appGpuTempGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </>
      )}

      {/* Container list */}
      {containers.length > 0 && (
        <ContainerTable containers={containers} />
      )}
    </div>
  );
}
