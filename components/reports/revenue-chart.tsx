"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";

type RevenueBucket = {
  month: string;
  incomeCents: number;
  expenseCents: number;
};

type RevenueChartProps = {
  data: RevenueBucket[];
  showExpenses?: boolean;
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatMonthTick(value: string): string {
  const date = new Date(value + "-01");
  return date.toLocaleDateString("en-US", { month: "short" });
}

export function RevenueChart({ data, showExpenses = false }: RevenueChartProps) {
  if (data.length === 0) return null;

  const chartConfig: ChartConfig = {
    income: {
      label: "Income",
      color: "var(--chart-1)",
    },
    ...(showExpenses
      ? {
          expenses: {
            label: "Expenses",
            color: "var(--chart-3)",
          },
        }
      : {}),
  };

  const chartData = data.map((d) => ({
    month: d.month,
    income: d.incomeCents / 100,
    expenses: d.expenseCents / 100,
  }));

  return (
    <Card className="squircle">
      <CardHeader>
        <CardTitle className="text-base">Revenue Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-[300px] w-full">
          <AreaChart accessibilityLayer data={chartData} margin={{ left: 12, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="month"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatMonthTick}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `$${Number(value).toLocaleString()}`}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={formatMonthTick}
                  formatter={(value) => formatCurrency(Number(value) * 100)}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Area
              dataKey="income"
              type="monotone"
              fill="var(--color-income)"
              fillOpacity={0.3}
              stroke="var(--color-income)"
              strokeWidth={2}
            />
            {showExpenses && (
              <Area
                dataKey="expenses"
                type="monotone"
                fill="var(--color-expenses)"
                fillOpacity={0.1}
                stroke="var(--color-expenses)"
                strokeWidth={2}
              />
            )}
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
