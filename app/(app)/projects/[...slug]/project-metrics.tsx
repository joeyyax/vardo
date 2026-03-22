"use client";

import { useState, useEffect, useRef, useId } from "react";
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
import { formatBytes, formatBytesRate, formatTime } from "@/lib/metrics/format";
import { RANGE_MS, BUCKET_MS, chartTooltipStyle, chartTickStyle, CHART_COLORS, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import type { ContainerStatsSnapshot } from "@/lib/metrics/types";
import { useVisibilityKey } from "@/lib/hooks/use-visible";

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

type AggPoint = {
  time: string;
  timestamp: number;
  cpu: number;
  memory: number;
  rxRate: number;
  txRate: number;
};


export function ProjectMetrics({ orgId, projectId, apps }: ProjectMetricsProps) {
  const uid = useId();
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [data, setData] = useState<AggPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const prevNetworkRef = useRef<Map<string, { rx: number; tx: number; ts: number }>>(new Map());
  const visKey = useVisibilityKey();

  // Load historical data from the project-level endpoint (single request)
  useEffect(() => {
    const now = Date.now();
    const from = now - RANGE_MS[timeRange];
    const bucket = BUCKET_MS[timeRange];

    async function loadHistory() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/projects/${projectId}/stats/history?from=${from}&to=${now}&bucket=${bucket}`
        );
        if (!res.ok) { setData([]); setLoading(false); return; }
        const { series } = await res.json();

        if (!series?.cpu) { setData([]); setLoading(false); return; }

        const merged: AggPoint[] = (series.cpu as [number, number][]).map(([ts, cpuVal]: [number, number], i: number) => ({
          time: formatTime(ts),
          timestamp: ts,
          cpu: Math.round(cpuVal * 100) / 100,
          memory: series.memory?.[i]?.[1] || 0,
          rxRate: series.networkRx?.[i]?.[1] || 0,
          txRate: series.networkTx?.[i]?.[1] || 0,
        }));

        setData(merged);
      } catch {
        setData([]);
      }
      setLoading(false);
    }

    loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, timeRange]);

  // Live SSE stream — single connection to project endpoint
  // Disconnects when tab is hidden, reconnects when visible
  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return;

    const es = new EventSource(
      `/api/v1/organizations/${orgId}/projects/${projectId}/stats/stream`
    );

    es.addEventListener("stats", (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          apps: { id: string; name: string; containers: ContainerStatsSnapshot[] }[];
        };

        const now = Date.now();
        let aggCpu = 0, aggMem = 0, aggRxRate = 0, aggTxRate = 0;

        for (const app of payload.apps) {
          const totalRx = app.containers.reduce((s, c) => s + c.networkRx, 0);
          const totalTx = app.containers.reduce((s, c) => s + c.networkTx, 0);

          const prev = prevNetworkRef.current.get(app.id);
          let rxRate = 0, txRate = 0;
          if (prev) {
            const dt = (now - prev.ts) / 1000;
            if (dt > 0) {
              rxRate = Math.max(0, (totalRx - prev.rx) / dt);
              txRate = Math.max(0, (totalTx - prev.tx) / dt);
            }
          }
          prevNetworkRef.current.set(app.id, { rx: totalRx, tx: totalTx, ts: now });

          aggCpu += app.containers.reduce((s, c) => s + c.cpuPercent, 0);
          aggMem += app.containers.reduce((s, c) => s + c.memoryUsage, 0);
          aggRxRate += rxRate;
          aggTxRate += txRate;
        }

        setData((prev) => {
          const next = [...prev, {
            time: formatTime(now),
            timestamp: now,
            cpu: Math.round(aggCpu * 100) / 100,
            memory: aggMem,
            rxRate: aggRxRate,
            txRate: aggTxRate,
          }];
          if (next.length > 300) next.splice(0, next.length - 300);
          return next;
        });
      } catch { /* skip */ }
    });

    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, visKey]);

  if (loading && data.length === 0) {
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
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`cpu-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.cpu} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.cpu} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} />
            <YAxis tick={chartTickStyle} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} domain={[0, "auto"]} width={45} />
            <Tooltip {...chartTooltipStyle} formatter={(v: number) => [`${v.toFixed(2)}%`, "CPU"]} />
            <Area type="monotone" dataKey="cpu" stroke={CHART_COLORS.cpu} fill={`url(#cpu-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Memory" icon={MemoryStick}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`mem-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_COLORS.memory} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_COLORS.memory} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
            <XAxis dataKey="time" tick={chartTickStyle} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} />
            <YAxis tick={chartTickStyle} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v, 0)} domain={[0, "auto"]} width={60} />
            <Tooltip {...chartTooltipStyle} formatter={(v: number) => [formatBytes(v), "Memory"]} />
            <Area type="monotone" dataKey="memory" stroke={CHART_COLORS.memory} fill={`url(#mem-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Network" icon={Network}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
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
            <XAxis dataKey="time" tick={chartTickStyle} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} />
            <YAxis tick={chartTickStyle} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytesRate(v)} domain={[0, "auto"]} width={70} />
            <Tooltip {...chartTooltipStyle} formatter={(v: number, name: string) => [formatBytesRate(v), name === "rxRate" ? "RX" : "TX"]} />
            <Area type="monotone" dataKey="rxRate" stroke={CHART_COLORS.networkRx} fill={`url(#rx-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} name="rxRate" />
            <Area type="monotone" dataKey="txRate" stroke={CHART_COLORS.networkTx} fill={`url(#tx-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} name="txRate" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
