"use client";

import { useState, useMemo } from "react";
import { AreaChart } from "@tremor/react";
import type { CustomTooltipProps } from "@tremor/react";
import { Loader2 } from "lucide-react";
import { Cpu, MemoryStick, Network } from "lucide-react";
import { ChartCard } from "@/components/app-status";
import { formatBytes, formatTime } from "@/lib/metrics/format";
import { TIME_RANGES, type TimeRange } from "@/lib/metrics/constants";
import { TREMOR_METRIC_COLORS, MetricsTooltip } from "@/components/metrics-chart";
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
      valueFormatter={(v) => formatBytes(v)}
      categoryLabels={{ networkRx: "Received", networkTx: "Sent" }}
    />
  );
}

export function ProjectMetrics({ orgId, projectId, apps }: ProjectMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const { points, loading } = useMetricsStream({
    historyUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/history`,
    streamUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/stream`,
    timeRange,
  });

  const chartPoints = useMemo(
    () => points.map((p) => ({ ...p, time: formatTime(p.timestamp) })),
    [points],
  );

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
          className="h-[200px]"
          data={chartPoints}
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

      <ChartCard title="Memory" icon={MemoryStick}>
        <AreaChart
          className="h-[200px]"
          data={chartPoints}
          index="time"
          categories={["memory"]}
          colors={[TREMOR_METRIC_COLORS.memory]}
          valueFormatter={(v) => formatBytes(v)}
          showLegend={false}
          showAnimation={false}
          curveType="monotone"
          autoMinValue={false}
          minValue={0}
          customTooltip={MemTooltip}
        />
      </ChartCard>

      <ChartCard title="Network" icon={Network}>
        <AreaChart
          className="h-[200px]"
          data={chartPoints}
          index="time"
          categories={["networkRx", "networkTx"]}
          colors={[TREMOR_METRIC_COLORS.networkRx, TREMOR_METRIC_COLORS.networkTx]}
          valueFormatter={(v) => formatBytes(v)}
          showLegend={false}
          showAnimation={false}
          curveType="monotone"
          autoMinValue={false}
          minValue={0}
          customTooltip={NetTooltip}
        />
      </ChartCard>
    </div>
  );
}
