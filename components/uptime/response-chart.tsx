"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TooltipFrame, TooltipRow } from "@/components/metrics-chart";
import { Card } from "@/components/ui/card";
import { CHART_COLORS, chartTickStyle } from "@/lib/metrics/constants";
import { formatTime } from "@/lib/uptime/core/range";
import type { LatencySeries } from "@/lib/uptime/types";
import { useUptimeTimeZone } from "./time-zone";

const SERIES_COLORS = [CHART_COLORS.cpu, CHART_COLORS.memory, CHART_COLORS.networkRx, CHART_COLORS.networkTx];

type Row = { at: number } & Record<string, number>;

/** Response time over the last 24 hours, one line per vantage point. */
export function ResponseChart({ series, height = 220 }: { series: LatencySeries[]; height?: number }) {
  const timeZone = useUptimeTimeZone();
  const data = useMemo(() => {
    const rows = new Map<number, Row>();
    for (const s of series) {
      for (const p of s.points) {
        const row = rows.get(p.at) ?? ({ at: p.at } as Row);
        row[s.vantageId] = p.ms;
        rows.set(p.at, row);
      }
    }
    return [...rows.values()].sort((a, b) => a.at - b.at);
  }, [series]);

  if (data.length === 0) {
    return (
      <Card variant="inset" className="flex items-center justify-center" style={{ height }}>
        <p className="text-xs text-muted-foreground">No responses in the last 24 hours</p>
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {series.map((s, i) => (
          <span key={s.vantageId} className="flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {s.name}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
          <XAxis dataKey="at" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => formatTime(v, timeZone)} tick={chartTickStyle} />
          <YAxis width={56} tickFormatter={(v: number) => `${v} ms`} tick={chartTickStyle} />
          <Tooltip
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipFrame label={formatTime(Number(label), timeZone)}>
                  {payload.map((p) => (
                    <TooltipRow
                      key={String(p.dataKey)}
                      color={String(p.color)}
                      label={series.find((s) => s.vantageId === p.dataKey)?.name ?? String(p.dataKey)}
                      value={`${p.value} ms`}
                    />
                  ))}
                </TooltipFrame>
              ) : null
            }
          />
          {series.map((s, i) => (
            <Line
              key={s.vantageId}
              dataKey={s.vantageId}
              type="monotone"
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
