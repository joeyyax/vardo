"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Activity, Container, Cpu, HardDrive, MemoryStick, Network, Loader2 } from "lucide-react";
import { formatBytes, formatMemLimit, formatBytesRate, formatTime } from "@/lib/metrics/format";
import { RANGE_MS, BUCKET_MS, chartTooltipStyle, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import type { ContainerStatsSnapshot } from "@/lib/metrics/types";

type TimeSeriesPoint = {
  time: string;
  timestamp: number;
  // Aggregate across containers
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  // Per-tick deltas for network rate
  networkRxRate: number;
  networkTxRate: number;
};

type AppMetricsProps = {
  orgId: string;
  appId: string;
  environmentName?: string;
};

const MAX_DATA_POINTS = 150; // ~5 minutes at 2s intervals

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

function ContainerTable({ containers }: { containers: ContainerStatsSnapshot[] }) {
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

export function AppMetrics({ orgId, appId, environmentName }: AppMetricsProps) {
  const [data, setData] = useState<TimeSeriesPoint[]>([]);
  const [containers, setContainers] = useState<ContainerStatsSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const prevNetworkRef = useRef<{ rx: number; tx: number } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  // Load historical data
  useEffect(() => {
    const now = Date.now();
    const from = now - RANGE_MS[timeRange];
    const bucket = BUCKET_MS[timeRange];

    async function loadHistory() {
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/apps/${appId}/stats/history?from=${from}&to=${now}&bucket=${bucket}`
        );
        if (!res.ok) { setHistoryLoaded(true); return; }
        const { series } = await res.json();

        if (!series.cpu?.length) { setHistoryLoaded(true); return; }

        // Convert time-series points to chart format
        const historyPoints: TimeSeriesPoint[] = series.cpu.map(([ts, cpu]: [number, number], i: number) => {
          const mem = series.memory[i] || [ts, 0];
          const memLimit = series.memoryLimit[i] || [ts, 0];
          const rx = series.networkRx[i] || [ts, 0];
          const tx = series.networkTx[i] || [ts, 0];
          const memUsage = mem[1];
          const memLim = memLimit[1];
          return {
            time: formatTime(ts),
            timestamp: ts,
            cpuPercent: Math.round(cpu * 100) / 100,
            memoryUsage: memUsage,
            memoryLimit: memLim,
            memoryPercent: memLim > 0 ? Math.round((memUsage / memLim) * 100 * 100) / 100 : 0,
            networkRx: rx[1],
            networkTx: tx[1],
            networkRxRate: 0,
            networkTxRate: 0,
          };
        });

        setData(historyPoints);
      } catch {
        // History not available — that's fine, live data will populate
      }
      setHistoryLoaded(true);
    }

    loadHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, appId, timeRange]);

  const handleStatsEvent = useCallback((event: MessageEvent) => {
    try {
      const payload = JSON.parse(event.data) as {
        containers: ContainerStatsSnapshot[];
        timestamp: string;
      };

      setContainers(payload.containers);
      setConnected(true);
      setError(null);

      if (payload.containers.length === 0) return;

      // Aggregate across all containers
      const totals = payload.containers.reduce(
        (acc, c) => ({
          cpuPercent: acc.cpuPercent + c.cpuPercent,
          memoryUsage: acc.memoryUsage + c.memoryUsage,
          memoryLimit: acc.memoryLimit + c.memoryLimit,
          memoryPercent: acc.memoryPercent + c.memoryPercent,
          networkRx: acc.networkRx + c.networkRx,
          networkTx: acc.networkTx + c.networkTx,
        }),
        { cpuPercent: 0, memoryUsage: 0, memoryLimit: 0, memoryPercent: 0, networkRx: 0, networkTx: 0 }
      );

      // Calculate network rates from cumulative counters
      let networkRxRate = 0;
      let networkTxRate = 0;
      if (prevNetworkRef.current) {
        const rxDelta = totals.networkRx - prevNetworkRef.current.rx;
        const txDelta = totals.networkTx - prevNetworkRef.current.tx;
        // 2 second intervals
        networkRxRate = Math.max(0, rxDelta / 2);
        networkTxRate = Math.max(0, txDelta / 2);
      }
      prevNetworkRef.current = { rx: totals.networkRx, tx: totals.networkTx };

      const ts = new Date(payload.timestamp).getTime();
      const point: TimeSeriesPoint = {
        time: formatTime(ts),
        timestamp: ts,
        cpuPercent: Math.round(totals.cpuPercent * 100) / 100,
        memoryUsage: totals.memoryUsage,
        memoryLimit: totals.memoryLimit,
        memoryPercent: Math.round(totals.memoryPercent * 100) / 100,
        networkRx: totals.networkRx,
        networkTx: totals.networkTx,
        networkRxRate,
        networkTxRate,
      };

      setData((prev) => {
        const next = [...prev, point];
        return next.length > MAX_DATA_POINTS ? next.slice(-MAX_DATA_POINTS) : next;
      });
    } catch {
      // Ignore parse errors
    }
  }, []);

  useEffect(() => {
    const url = `/api/v1/organizations/${orgId}/apps/${appId}/stats/stream${environmentName ? `?environment=${environmentName}` : ""}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("stats", handleStatsEvent);

    es.addEventListener("error", (event) => {
      // EventSource "error" event on SSE means either actual error or reconnection
      const data = (event as MessageEvent).data;
      if (data) {
        try {
          const parsed = JSON.parse(data);
          setError(parsed.message || "Connection error");
        } catch {
          setError("Connection lost, reconnecting...");
        }
      }
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [orgId, appId, handleStatsEvent]);

  // Loading state — show if no history and not connected
  if (!historyLoaded && !connected && !error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <Loader2 className="size-6 text-muted-foreground animate-spin" />
        <p className="text-sm text-muted-foreground">Loading metrics...</p>
      </div>
    );
  }

  // No containers running and no history
  if (connected && containers.length === 0 && data.length === 0) {
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

  // Error state
  if (error && containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  const latestMemoryLimit = data.length > 0 ? data[data.length - 1].memoryLimit : 0;


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
          <span className={`size-2 rounded-full ${connected ? "bg-status-success" : "bg-status-neutral"}`} />
          <span className="text-xs text-muted-foreground">
            {connected ? "Live" : "Historical"}
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

      {/* CPU Chart */}
      <ChartCard title="CPU Usage" icon={Cpu}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.65 0.19 255)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.65 0.19 255)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.30 0.006 285.75 / 40%)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "oklch(0.55 0.006 285.75)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={60}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "oklch(0.55 0.006 285.75)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}%`}
              domain={[0, "auto"]}
              width={45}
            />
            <Tooltip
              {...chartTooltipStyle}
              formatter={(value: number) => [`${value.toFixed(2)}%`, "CPU"]}
            />
            <Area
              type="monotone"
              dataKey="cpuPercent"
              stroke="oklch(0.65 0.19 255)"
              fill="url(#cpuGradient)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Memory Chart */}
      <ChartCard title="Memory Usage" icon={MemoryStick}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="memGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.72 0.17 150)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.72 0.17 150)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.30 0.006 285.75 / 40%)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "oklch(0.55 0.006 285.75)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={60}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "oklch(0.55 0.006 285.75)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => formatBytes(v, 0)}
              domain={[0, "auto"]}
              width={60}
            />
            <Tooltip
              {...chartTooltipStyle}
              formatter={(value: number) => [formatBytes(value), "Memory"]}
            />
            {latestMemoryLimit > 0 && (
              <ReferenceLine
                y={latestMemoryLimit}
                stroke="oklch(0.65 0.22 25)"
                strokeDasharray="4 4"
                strokeWidth={1}
                label={{
                  value: `Limit: ${formatBytes(latestMemoryLimit, 0)}`,
                  position: "insideTopRight",
                  fill: "oklch(0.65 0.22 25)",
                  fontSize: 10,
                }}
              />
            )}
            <Area
              type="monotone"
              dataKey="memoryUsage"
              stroke="oklch(0.72 0.17 150)"
              fill="url(#memGradient)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Network I/O Chart */}
      <ChartCard title="Network I/O" icon={Network}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="rxGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.70 0.15 200)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.70 0.15 200)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="txGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="oklch(0.75 0.15 75)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="oklch(0.75 0.15 75)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.30 0.006 285.75 / 40%)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "oklch(0.55 0.006 285.75)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={60}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "oklch(0.55 0.006 285.75)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => formatBytesRate(v)}
              domain={[0, "auto"]}
              width={70}
            />
            <Tooltip
              {...chartTooltipStyle}
              formatter={(value: number, name: string) => [
                formatBytesRate(value),
                name === "networkRxRate" ? "RX" : "TX",
              ]}
            />
            <Area
              type="monotone"
              dataKey="networkRxRate"
              stroke="oklch(0.70 0.15 200)"
              fill="url(#rxGradient)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              name="networkRxRate"
            />
            <Area
              type="monotone"
              dataKey="networkTxRate"
              stroke="oklch(0.75 0.15 75)"
              fill="url(#txGradient)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              name="networkTxRate"
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Container list */}
      {containers.length > 0 && (
        <ContainerTable containers={containers} />
      )}
    </div>
  );
}
