"use client";

import { useState, useEffect, useRef } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Cpu, MemoryStick, Network, Loader2 } from "lucide-react";
import { formatBytes, formatBytesRate, formatTime } from "@/lib/metrics/format";
import { RANGE_MS, BUCKET_MS, chartTooltipStyle, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import type { ContainerStatsSnapshot } from "@/lib/metrics/types";

type AppInfo = {
  id: string;
  name: string;
  displayName: string;
};

type ProjectMetricsProps = {
  orgId: string;
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

let pmUid = 0;

function ChartCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="squircle rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b">
        <Icon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export function ProjectMetrics({ orgId, apps }: ProjectMetricsProps) {
  const [uid] = useState(() => `pm${++pmUid}`);
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [data, setData] = useState<AggPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const eventSourcesRef = useRef<EventSource[]>([]);
  const liveDataRef = useRef<Map<string, { cpu: number; mem: number; rxRate: number; txRate: number }>>(new Map());
  const prevNetworkRef = useRef<Map<string, { rx: number; tx: number; ts: number }>>(new Map());

  const appIds = apps.map((a) => a.id).join(",");

  // Load historical data for all apps, aggregate into single series
  useEffect(() => {
    const now = Date.now();
    const from = now - RANGE_MS[timeRange];
    const bucket = BUCKET_MS[timeRange];

    async function loadHistory() {
      setLoading(true);
      try {
        const results = await Promise.all(
          apps.map(async (app) => {
            try {
              const res = await fetch(
                `/api/v1/organizations/${orgId}/apps/${app.id}/stats/history?from=${from}&to=${now}&bucket=${bucket}`
              );
              if (!res.ok) return null;
              const { series } = await res.json();
              return series;
            } catch {
              return null;
            }
          })
        );

        // Collect all timestamps
        const tsSet = new Set<number>();
        for (const series of results) {
          if (!series?.cpu) continue;
          for (const [ts] of series.cpu) tsSet.add(ts);
        }

        const timestamps = Array.from(tsSet).sort((a, b) => a - b);
        if (timestamps.length === 0) {
          setData([]);
          setLoading(false);
          return;
        }

        // Build per-timestamp lookup for each app
        const lookups = results.map((series) => {
          if (!series?.cpu) return null;
          const map = new Map<number, number>();
          series.cpu.forEach(([ts, val]: [number, number], _i: number) => map.set(ts, _i));
          return { map, series };
        });

        const merged: AggPoint[] = timestamps.map((ts) => {
          let cpu = 0, mem = 0, rx = 0, tx = 0;
          for (const lookup of lookups) {
            if (!lookup) continue;
            const idx = lookup.map.get(ts);
            if (idx === undefined) continue;
            cpu += lookup.series.cpu[idx]?.[1] || 0;
            mem += lookup.series.memory[idx]?.[1] || 0;
            rx += lookup.series.networkRx[idx]?.[1] || 0;
            tx += lookup.series.networkTx[idx]?.[1] || 0;
          }
          return {
            time: formatTime(ts),
            timestamp: ts,
            cpu: Math.round(cpu * 100) / 100,
            memory: mem,
            rxRate: rx,
            txRate: tx,
          };
        });

        setData(merged);
      } catch {
        // Failed
      }
      setLoading(false);
    }

    loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, appIds, timeRange]);

  // Live SSE streams — aggregate across all apps
  useEffect(() => {
    for (const es of eventSourcesRef.current) es.close();
    eventSourcesRef.current = [];

    for (const app of apps) {
      const es = new EventSource(
        `/api/v1/organizations/${orgId}/apps/${app.id}/stats/stream`
      );
      es.addEventListener("stats", (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as {
            containers: ContainerStatsSnapshot[];
          };
          const c = payload.containers;
          const cpu = c.reduce((s, x) => s + x.cpuPercent, 0);
          const mem = c.reduce((s, x) => s + x.memoryUsage, 0);
          const totalRx = c.reduce((s, x) => s + x.networkRx, 0);
          const totalTx = c.reduce((s, x) => s + x.networkTx, 0);
          const now = Date.now();

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
          liveDataRef.current.set(app.id, { cpu, mem, rxRate, txRate });

          // Sum across all apps
          let aggCpu = 0, aggMem = 0, aggRx = 0, aggTx = 0;
          for (const a of apps) {
            const d = liveDataRef.current.get(a.id);
            if (d) { aggCpu += d.cpu; aggMem += d.mem; aggRx += d.rxRate; aggTx += d.txRate; }
          }

          setData((prev) => {
            const next = [...prev, {
              time: formatTime(now),
              timestamp: now,
              cpu: Math.round(aggCpu * 100) / 100,
              memory: aggMem,
              rxRate: aggRx,
              txRate: aggTx,
            }];
            if (next.length > 300) next.splice(0, next.length - 300);
            return next;
          });
        } catch { /* skip */ }
      });
      eventSourcesRef.current.push(es);
    }

    return () => {
      for (const es of eventSourcesRef.current) es.close();
      eventSourcesRef.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, appIds]);

  if (loading && data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const grid = "oklch(0.30 0.006 285.75 / 40%)";
  const tick = { fontSize: 10, fill: "oklch(0.55 0.006 285.75)" };

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
                <stop offset="5%" stopColor="oklch(0.65 0.19 255)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.65 0.19 255)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={grid} />
            <XAxis dataKey="time" tick={tick} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} />
            <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} domain={[0, "auto"]} width={45} />
            <Tooltip {...chartTooltipStyle} formatter={(v: number) => [`${v.toFixed(2)}%`, "CPU"]} />
            <Area type="monotone" dataKey="cpu" stroke="oklch(0.65 0.19 255)" fill={`url(#cpu-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Memory" icon={MemoryStick}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`mem-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.72 0.17 150)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.72 0.17 150)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={grid} />
            <XAxis dataKey="time" tick={tick} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} />
            <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytes(v, 0)} domain={[0, "auto"]} width={60} />
            <Tooltip {...chartTooltipStyle} formatter={(v: number) => [formatBytes(v), "Memory"]} />
            <Area type="monotone" dataKey="memory" stroke="oklch(0.72 0.17 150)" fill={`url(#mem-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Network" icon={Network}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`rx-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.70 0.15 200)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.70 0.15 200)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`tx-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.75 0.15 75)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.75 0.15 75)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={grid} />
            <XAxis dataKey="time" tick={tick} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={60} />
            <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => formatBytesRate(v)} domain={[0, "auto"]} width={70} />
            <Tooltip {...chartTooltipStyle} formatter={(v: number, name: string) => [formatBytesRate(v), name === "rxRate" ? "RX" : "TX"]} />
            <Area type="monotone" dataKey="rxRate" stroke="oklch(0.70 0.15 200)" fill={`url(#rx-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} name="rxRate" />
            <Area type="monotone" dataKey="txRate" stroke="oklch(0.75 0.15 75)" fill={`url(#tx-${uid})`} strokeWidth={1.5} dot={false} isAnimationActive={false} name="txRate" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
