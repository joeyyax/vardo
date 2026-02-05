"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";

type HoursBucket = {
  date: string;
  billableMinutes: number;
  unbillableMinutes: number;
};

type HoursChartProps = {
  data: HoursBucket[];
};

const chartConfig = {
  billable: {
    label: "Billable",
    color: "var(--chart-1)",
  },
  unbillable: {
    label: "Unbillable",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

function formatTickLabel(value: string): string {
  if (value.length === 7) {
    const date = new Date(value + "-01");
    return date.toLocaleDateString("en-US", { month: "short" });
  }
  const date = new Date(value + "T12:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function HoursChart({ data }: HoursChartProps) {
  if (data.length === 0) return null;

  const chartData = data.map((d) => ({
    date: d.date,
    billable: +(d.billableMinutes / 60).toFixed(1),
    unbillable: +(d.unbillableMinutes / 60).toFixed(1),
  }));

  return (
    <Card className="squircle">
      <CardHeader>
        <CardTitle className="text-base">Hours Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-[300px] w-full">
          <BarChart accessibilityLayer data={chartData}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={formatTickLabel}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}h`}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={formatTickLabel}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar
              dataKey="billable"
              stackId="hours"
              fill="var(--color-billable)"
              radius={[0, 0, 4, 4]}
            />
            <Bar
              dataKey="unbillable"
              stackId="hours"
              fill="var(--color-unbillable)"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
