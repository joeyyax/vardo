"use client";

import { useState, useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Cpu, MemoryStick, Network } from "lucide-react";
import { ChartCard } from "@/components/app-status";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBytes, formatBytesShort, formatCores, formatCoresShort, formatTime } from "@/lib/metrics/format";
import { CHART_COLORS, chartTickStyle, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import { MetricsTooltip } from "@/components/metrics-chart";
import { NetworkChart } from "@/components/network-chart";
import { networkBarPoint } from "@/lib/metrics/network-chart";
import { networkRates } from "@/lib/metrics/rates";
import { useMetricsStream } from "@/hooks/use-metrics-stream";

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

export function ProjectMetrics({ orgId, projectId, apps }: ProjectMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const { points, loading, error, connected } = useMetricsStream({
    historyUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/history`,
    streamUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/stream`,
    timeRange,
  });

  // Cumulative counters become per-second rates; a counter reset reads as unknown.
  const chartPoints = useMemo(() => {
    const rates = networkRates(points);
    return points.map((p, i) => ({
      ...p,
      time: formatTime(p.timestamp),
      ...networkBarPoint(rates[i]),
    }));
  }, [points]);

  if (error && !connected && !loading && points.length === 0) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Metrics unavailable"
        body="Could not connect to the metrics service. This may be a temporary issue."
      />
    );
  }

  const latestCpu = points.length > 0 ? points[points.length - 1].cpu : null;

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

      <ChartCard title="CPU" icon={Cpu} value={formatCores(latestCpu)}>
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
            <YAxis width={45} tickFormatter={formatCoresShort} tick={chartTickStyle} />
            <Tooltip content={<CpuTooltip />} />
            <Area isAnimationActive={false} type="monotone" dataKey="cpu" stroke={CHART_COLORS.cpu} fill="url(#projCpuGradient)" />
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
            <Area isAnimationActive={false} type="monotone" dataKey="memory" stroke={CHART_COLORS.memory} fill="url(#projMemGradient)" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Network" icon={Network}>
        <NetworkChart data={chartPoints} />
      </ChartCard>
    </div>
  );
}
