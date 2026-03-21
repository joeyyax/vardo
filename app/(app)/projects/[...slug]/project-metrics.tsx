"use client";

import { useState, useMemo } from "react";
import { AreaChart } from "@tremor/react";
import type { CustomTooltipProps } from "@tremor/react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Cpu, MemoryStick, Network } from "lucide-react";
import { ChartCard } from "@/components/app-status";
import { formatBytes, formatBytesShort, formatBytesRate, formatBytesRateShort, formatTime } from "@/lib/metrics/format";
import { TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import { TREMOR_METRIC_COLORS, CHART_DEFAULTS, MetricsTooltip } from "@/components/metrics-chart";
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

function CpuTooltip(props: CustomTooltipProps) {
  return (
    <MetricsTooltip
      {...props}
      valueFormatter={(v) => `${v.toFixed(1)}%`}
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

  // Compute network rates from cumulative counters (delta bytes / delta seconds)
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
        return { ...p, time: formatTime(p.timestamp), networkRxRate, networkTxRate };
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
        <AreaChart
          {...CHART_DEFAULTS}
          className="h-[200px]"
          data={chartPoints}
          index="time"
          categories={["cpu"]}
          colors={[TREMOR_METRIC_COLORS.cpu]}
          valueFormatter={(v) => `${v.toFixed(1)}%`}
          customTooltip={CpuTooltip}
        />
      </ChartCard>

      <ChartCard title="Memory" icon={MemoryStick}>
        <AreaChart
          {...CHART_DEFAULTS}
          className="h-[200px]"
          data={chartPoints}
          index="time"
          categories={["memory"]}
          colors={[TREMOR_METRIC_COLORS.memory]}
          valueFormatter={(v) => formatBytesShort(v)}
          customTooltip={MemTooltip}
        />
      </ChartCard>

      <ChartCard title="Network" icon={Network}>
        <AreaChart
          {...CHART_DEFAULTS}
          className="h-[200px]"
          data={chartPoints}
          index="time"
          categories={["networkRxRate", "networkTxRate"]}
          colors={[TREMOR_METRIC_COLORS.networkRxRate, TREMOR_METRIC_COLORS.networkTxRate]}
          valueFormatter={(v) => formatBytesRateShort(v)}
          customTooltip={NetTooltip}
        />
      </ChartCard>
    </div>
  );
}
