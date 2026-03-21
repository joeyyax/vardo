"use client";

import { useState, useMemo } from "react";
import { AreaChart } from "@tremor/react";
import type { CustomTooltipProps } from "@tremor/react";
import { Activity, Container, Cpu, MemoryStick, Network, Loader2 } from "lucide-react";
import { ChartCard } from "@/components/app-status";
import { formatBytes, formatMemLimit, formatBytesRate, formatTime } from "@/lib/metrics/format";
import { CHART_COLORS, TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import { TREMOR_METRIC_COLORS, MetricsTooltip } from "@/components/metrics-chart";
import type { ContainerPoint } from "@/lib/metrics/types";
import { useMetricsStream } from "@/lib/hooks/use-metrics-stream";

type AppMetricsProps = {
  orgId: string;
  appId: string;
  environmentName?: string;
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
};

/* ── Stable tooltip components (outside render to avoid re-creation) ── */

function CpuTooltip(props: CustomTooltipProps) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => `${v.toFixed(2)}%`}
      categoryLabels={{ cpu: "CPU" }}
    />
  );
}

function MemTooltip(props: CustomTooltipProps) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => formatBytes(v)}
      categoryLabels={{ memory: "Memory" }}
    />
  );
}

function NetTooltip(props: CustomTooltipProps) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => formatBytesRate(v)}
      categoryLabels={{ networkRxRate: "RX", networkTxRate: "TX" }}
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

export function AppMetrics({ orgId, appId, environmentName }: AppMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const { points, containers, connected, loading } = useMetricsStream({
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
      };
    });
  }, [points]);

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
        <AreaChart
          className="h-[200px]"
          data={chartData}
          index="time"
          categories={["cpu"]}
          colors={[TREMOR_METRIC_COLORS.cpu]}
          valueFormatter={(v) => `${v.toFixed(2)}%`}
          showLegend={false}
          showAnimation={false}
          curveType="monotone"
          autoMinValue={false}
          minValue={0}
          customTooltip={CpuTooltip}
        />
      </ChartCard>

      {/* Memory Chart */}
      <ChartCard title="Memory Usage" icon={MemoryStick}>
        {latestMemoryLimit > 0 && (
          <p className="text-[10px] text-muted-foreground mb-1" style={{ color: CHART_COLORS.memoryLimit }}>
            Limit: {formatBytes(latestMemoryLimit, 0)}
          </p>
        )}
        <AreaChart
          className="h-[200px]"
          data={chartData}
          index="time"
          categories={["memory"]}
          colors={[TREMOR_METRIC_COLORS.memory]}
          valueFormatter={(v) => formatBytes(v)}
          yAxisWidth={65}
          showLegend={false}
          showAnimation={false}
          curveType="monotone"
          autoMinValue={false}
          minValue={0}
          maxValue={latestMemoryLimit > 0 ? latestMemoryLimit * 1.1 : undefined}
          customTooltip={MemTooltip}
        />
      </ChartCard>

      {/* Network I/O Chart */}
      <ChartCard title="Network I/O" icon={Network}>
        <AreaChart
          className="h-[200px]"
          data={chartData}
          index="time"
          categories={["networkRxRate", "networkTxRate"]}
          colors={[TREMOR_METRIC_COLORS.networkRxRate, TREMOR_METRIC_COLORS.networkTxRate]}
          valueFormatter={(v) => formatBytesRate(v)}
          yAxisWidth={75}
          showLegend={false}
          showAnimation={false}
          curveType="monotone"
          autoMinValue={false}
          minValue={0}
          customTooltip={NetTooltip}
        />
      </ChartCard>

      {/* Container list */}
      {containers.length > 0 && (
        <ContainerTable containers={containers} />
      )}
    </div>
  );
}
