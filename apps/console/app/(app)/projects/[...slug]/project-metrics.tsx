"use client";

import { useState, useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Cpu, MemoryStick, Network } from "lucide-react";
import { ChartCard } from "@/components/app-status";
import { formatBytes, formatBytesShort, formatTime } from "@/lib/metrics/format";
import { CHART_COLORS, chartTickStyle, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import { MetricsTooltip } from "@/components/metrics-chart";
import { useMetricsStream } from "@/lib/hooks/use-metrics-stream";

type AppInfo = {
  id: string;
  name: string;
  displayName: string;
};

type ProjectMetricsProps = {
  orgId: string;
  projectId: string;
  apps: AppInfo[];
};

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
      valueFormatter={(v) => `${formatBytesShort(v)}/s`}
      categoryLabels={{ networkRxRate: "Received", networkTxRate: "Sent" }}
    />
  );
}

export function ProjectMetrics({ orgId, projectId, apps }: ProjectMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const { points, loading, error, connected } = useMetricsStream({
    historyUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/history`,
    streamUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/stream`,
    timeRange,
  });

  // Compute network rates (delta per second) instead of cumulative totals
  const chartPoints = useMemo(
    () =>
      points.map((p, i) => {
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
          ...p,
          time: formatTime(p.timestamp),
          networkRxRate,
          networkTxRate,
        };
      }),
    [points],
  );

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

  if (loading && points.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }


  return (
    <div className="space-y-4">
      <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
        {TIME_RANGES.map((r) => (
          <button
            key={r.value}
            type="button"
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

      <ChartCard title="CPU" icon={Cpu}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartPoints}>
            <defs>
              <linearGradient id="projCpuGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.cpu} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.cpu} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} />
            <YAxis width={45} tickFormatter={(v) => `${v}%`} tick={chartTickStyle} />
            <Tooltip content={<CpuTooltip />} />
            <Area type="monotone" dataKey="cpu" stroke={CHART_COLORS.cpu} fill="url(#projCpuGradient)" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Memory" icon={MemoryStick}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartPoints}>
            <defs>
              <linearGradient id="projMemGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.memory} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.memory} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} />
            <YAxis width={65} tickFormatter={formatBytesShort} tick={chartTickStyle} />
            <Tooltip content={<MemTooltip />} />
            <Area type="monotone" dataKey="memory" stroke={CHART_COLORS.memory} fill="url(#projMemGradient)" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Network" icon={Network}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartPoints}>
            <defs>
              <linearGradient id="projNetRxGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.networkRx} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.networkRx} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="projNetTxGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.networkTx} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.networkTx} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} />
            <YAxis width={65} tickFormatter={(v) => `${formatBytesShort(v)}/s`} tick={chartTickStyle} />
            <Tooltip content={<NetTooltip />} />
            <Area type="monotone" dataKey="networkRxRate" stroke={CHART_COLORS.networkRx} fill="url(#projNetRxGradient)" />
            <Area type="monotone" dataKey="networkTxRate" stroke={CHART_COLORS.networkTx} fill="url(#projNetTxGradient)" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
