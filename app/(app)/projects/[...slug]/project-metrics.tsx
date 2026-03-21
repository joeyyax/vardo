"use client";

import { useState, useId } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Loader2 } from "lucide-react";
import { Cpu, MemoryStick, Network } from "lucide-react";
import { ChartCard } from "@/components/app-status";
import { formatBytes, formatTime } from "@/lib/metrics/format";
import { chartTooltipStyle, chartTickStyle, CHART_COLORS, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
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


export function ProjectMetrics({ orgId, projectId, apps }: ProjectMetricsProps) {
  const uid = useId();
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const { points, loading } = useMetricsStream({
    historyUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/history`,
    streamUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/stream`,
    timeRange,
  });

  if (loading && points.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }


  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {TIME_RANGES.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => setTimeRange(r.value)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              timeRange === r.value
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <ChartCard title="CPU" icon={Cpu}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={points} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`cpu-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.cpu} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.cpu} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="timestamp" tick={chartTickStyle} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} tickFormatter={(ts) => formatTime(ts)} />
            <YAxis tick={chartTickStyle} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} domain={[0, "auto"]} width={45} />
            <Tooltip {...chartTooltipStyle} labelFormatter={(ts) => formatTime(ts)} formatter={(v: number) => [`${v.toFixed(2)}%`, "CPU"]} />
            <Area type="monotone" dataKey="cpu" stroke={CHART_COLORS.cpu} fill={`url(#cpu-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Memory" icon={MemoryStick}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={points} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`mem-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.memory} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.memory} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="timestamp" tick={chartTickStyle} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} tickFormatter={(ts) => formatTime(ts)} />
            <YAxis tick={chartTickStyle} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v, 0)} domain={[0, "auto"]} width={60} />
            <Tooltip {...chartTooltipStyle} labelFormatter={(ts) => formatTime(ts)} formatter={(v: number) => [formatBytes(v), "Memory"]} />
            <Area type="monotone" dataKey="memory" stroke={CHART_COLORS.memory} fill={`url(#mem-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Network" icon={Network}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={points} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`rx-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.networkRx} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.networkRx} stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`tx-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.networkTx} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.networkTx} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="timestamp" tick={chartTickStyle} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} tickFormatter={(ts) => formatTime(ts)} />
            <YAxis tick={chartTickStyle} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v)} domain={[0, "auto"]} width={70} />
            <Tooltip {...chartTooltipStyle} labelFormatter={(ts) => formatTime(ts)} formatter={(v: number, name: string) => [formatBytes(v), name === "networkRx" ? "Received" : "Sent"]} />
            <Area type="monotone" dataKey="networkRx" stroke={CHART_COLORS.networkRx} fill={`url(#rx-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} name="networkRx" />
            <Area type="monotone" dataKey="networkTx" stroke={CHART_COLORS.networkTx} fill={`url(#tx-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} name="networkTx" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
