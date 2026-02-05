"use client";

import { Line, LineChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

type UtilizationBucket = {
  weekStart: string;
  totalMinutes: number;
  billableMinutes: number;
  percentage: number;
};

type UtilizationChartProps = {
  data: UtilizationBucket[];
};

const chartConfig = {
  utilization: {
    label: "Utilization",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

function formatWeekTick(value: string): string {
  const date = new Date(value + "T12:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function UtilizationChart({ data }: UtilizationChartProps) {
  if (data.length === 0) return null;

  const chartData = data.map((d) => ({
    weekStart: d.weekStart,
    utilization: d.percentage,
  }));

  return (
    <Card className="squircle">
      <CardHeader>
        <CardTitle className="text-base">Utilization Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-[300px] w-full">
          <LineChart accessibilityLayer data={chartData} margin={{ left: 12, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="weekStart"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={formatWeekTick}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              domain={[0, 100]}
              tickFormatter={(value) => `${value}%`}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={formatWeekTick}
                />
              }
            />
            <Line
              dataKey="utilization"
              type="monotone"
              stroke="var(--color-utilization)"
              strokeWidth={2}
              dot={{ r: 3, fill: "var(--color-utilization)" }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
