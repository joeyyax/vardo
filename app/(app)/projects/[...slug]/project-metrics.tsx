"use client";

import { useState } from "react";
import { AreaChart } from "@tremor/react";
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


export function ProjectMetrics({ orgId, projectId, apps }: ProjectMetricsProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");

  const { points, loading } = useMetricsStream({
    historyUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/history`,
    streamUrl: `/api/v1/organizations/${orgId}/projects/${projectId}/stats/stream`,
    timeRange,
  });

  const chartPoints = points.map((p) => ({
    ...p,
    time: formatTime(p.timestamp),
  }));

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
          customTooltip={(props) => (
            <MetricsTooltip
              {...props}
              valueFormatter={(v) => `${v.toFixed(2)}%`}
              categoryLabels={{ cpu: "CPU" }}
            />
          )}
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
          customTooltip={(props) => (
            <MetricsTooltip
              {...props}
              valueFormatter={(v) => formatBytes(v)}
              categoryLabels={{ memory: "Memory" }}
            />
          )}
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
          customTooltip={(props) => (
            <MetricsTooltip
              {...props}
              valueFormatter={(v) => formatBytes(v)}
              categoryLabels={{ networkRx: "Received", networkTx: "Sent" }}
            />
          )}
        />
      </ChartCard>
    </div>
  );
}
