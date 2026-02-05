# Reporting Charts & Universal Table Views

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace custom div-based visualizations with interactive shadcn charts, add time-series trend charts to the reports overview, and wire table views into every remaining page.

**Architecture:** Install shadcn `chart` component (wraps Recharts). Extend the existing `/analytics` API to return time-series buckets alongside its current totals. Create three new trend chart components and upgrade three existing report sections. Add table views to tasks, clients, expenses, and track pages using the existing ViewSwitcher + PageToolbar pattern.

**Tech Stack:** shadcn/ui charts (Recharts), Drizzle ORM (SQL grouping), existing ViewSwitcher/PageToolbar system

---

## Task 1: Install shadcn chart component

**Files:**
- Modify: `components/ui/chart.tsx` (auto-created by shadcn CLI)
- Modify: `package.json` (recharts added as dependency)

**Step 1: Install the chart component**

```bash
pnpm dlx shadcn@latest add chart
```

This installs `recharts` and creates `components/ui/chart.tsx` with `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent`, and `ChartConfig` type.

**Step 2: Verify installation**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add components/ui/chart.tsx package.json pnpm-lock.yaml
git commit -m "chore: install shadcn chart component (recharts)"
```

---

## Task 2: Extend analytics API with time-series data

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/analytics/route.ts`

The existing endpoint queries `timeEntries` joined with `clients`, `projects`, `tasks` for a date range and returns totals + `clientBreakdown` + `topProjects`. We add three new response fields computed from the same query results + two new DB queries.

**Step 1: Add `hoursByPeriod` — group existing entries by date bucket**

After the existing `entriesWithRelations` query (line ~96), add logic to bucket entries by date. The granularity depends on the date range span:

- ≤ 31 days → daily buckets (key: `YYYY-MM-DD`)
- ≤ 90 days → weekly buckets (key: Monday of each week, `YYYY-MM-DD`)
- Otherwise → monthly buckets (key: `YYYY-MM`)

```typescript
import { startOfWeek as startOfWeekFn, differenceInDays, parseISO } from "date-fns";

// After entriesWithRelations is populated:
const rangeSpanDays = differenceInDays(
  parseISO(toDateStr),
  parseISO(fromDateStr)
);

function getBucketKey(dateStr: string): string {
  if (rangeSpanDays <= 31) return dateStr; // daily
  if (rangeSpanDays <= 90) {
    const weekStart = startOfWeekFn(parseISO(dateStr), { weekStartsOn: 1 });
    return format(weekStart, "yyyy-MM-dd"); // weekly
  }
  return dateStr.slice(0, 7); // monthly "YYYY-MM"
}

const hoursBucketMap = new Map<string, { billableMinutes: number; unbillableMinutes: number }>();

for (const entry of entriesWithRelations) {
  const key = getBucketKey(entry.date);
  const existing = hoursBucketMap.get(key) ?? { billableMinutes: 0, unbillableMinutes: 0 };
  const isBillable = getIsBillable(entry);
  if (isBillable) {
    existing.billableMinutes += entry.durationMinutes;
  } else {
    existing.unbillableMinutes += entry.durationMinutes;
  }
  hoursBucketMap.set(key, existing);
}

const hoursByPeriod = Array.from(hoursBucketMap.entries())
  .map(([date, data]) => ({ date, ...data }))
  .sort((a, b) => a.date.localeCompare(b.date));
```

**Step 2: Add `utilizationByWeek` — group entries by week**

```typescript
const utilizationMap = new Map<string, { totalMinutes: number; billableMinutes: number }>();

for (const entry of entriesWithRelations) {
  const weekStart = format(
    startOfWeekFn(parseISO(entry.date), { weekStartsOn: 1 }),
    "yyyy-MM-dd"
  );
  const existing = utilizationMap.get(weekStart) ?? { totalMinutes: 0, billableMinutes: 0 };
  existing.totalMinutes += entry.durationMinutes;
  if (getIsBillable(entry)) {
    existing.billableMinutes += entry.durationMinutes;
  }
  utilizationMap.set(weekStart, existing);
}

const utilizationByWeek = Array.from(utilizationMap.entries())
  .map(([weekStart, data]) => ({
    weekStart,
    ...data,
    percentage: data.totalMinutes > 0
      ? Math.round((data.billableMinutes / data.totalMinutes) * 100)
      : 0,
  }))
  .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
```

**Step 3: Add `revenueByMonth` — query invoices + expenses grouped by month**

This requires two additional DB queries (invoices paid within the range, expenses within the range). Add these after the time entry processing:

```typescript
import { invoices, projectExpenses } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

// Revenue: paid invoices grouped by month of periodEnd
const invoiceRevenue = await db
  .select({
    month: sql<string>`to_char(${invoices.periodEnd}::date, 'YYYY-MM')`,
    totalCents: sql<number>`COALESCE(SUM(${invoices.subtotal}), 0)`,
  })
  .from(invoices)
  .where(
    and(
      eq(invoices.organizationId, orgId),
      eq(invoices.status, "paid"),
      gte(sql`${invoices.periodEnd}`, fromDateStr),
      lte(sql`${invoices.periodEnd}`, toDateStr)
    )
  )
  .groupBy(sql`to_char(${invoices.periodEnd}::date, 'YYYY-MM')`)
  .orderBy(sql`to_char(${invoices.periodEnd}::date, 'YYYY-MM')`);

// Expenses grouped by month
const expensesByMonth = await db
  .select({
    month: sql<string>`to_char(${projectExpenses.date}::date, 'YYYY-MM')`,
    totalCents: sql<number>`COALESCE(SUM(${projectExpenses.amountCents}), 0)`,
  })
  .from(projectExpenses)
  .where(
    and(
      eq(projectExpenses.organizationId, orgId),
      gte(projectExpenses.date, fromDateStr),
      lte(projectExpenses.date, toDateStr)
    )
  )
  .groupBy(sql`to_char(${projectExpenses.date}::date, 'YYYY-MM')`)
  .orderBy(sql`to_char(${projectExpenses.date}::date, 'YYYY-MM')`);

// Merge into unified revenueByMonth array
const revenueMonthMap = new Map<string, { incomeCents: number; expenseCents: number }>();
for (const row of invoiceRevenue) {
  revenueMonthMap.set(row.month, {
    incomeCents: Number(row.totalCents),
    expenseCents: 0,
  });
}
for (const row of expensesByMonth) {
  const existing = revenueMonthMap.get(row.month) ?? { incomeCents: 0, expenseCents: 0 };
  existing.expenseCents = Number(row.totalCents);
  revenueMonthMap.set(row.month, existing);
}

const revenueByMonth = Array.from(revenueMonthMap.entries())
  .map(([month, data]) => ({ month, ...data }))
  .sort((a, b) => a.month.localeCompare(b.month));
```

**Step 4: Add new fields to the JSON response**

In the existing `NextResponse.json({...})` call at the end, add the three new fields:

```typescript
return NextResponse.json({
  // ...existing fields unchanged...
  totalMinutes,
  totalBillable,
  totalUnbillableMinutes,
  uniqueClients: clientMap.size,
  averageHoursPerDay,
  clientBreakdown,
  topProjects,
  // New time-series fields
  hoursByPeriod,
  revenueByMonth,
  utilizationByWeek,
});
```

Also add them to the empty-data early return:

```typescript
if (entriesWithRelations.length === 0) {
  return NextResponse.json({
    // ...existing fields...
    hoursByPeriod: [],
    revenueByMonth: [],
    utilizationByWeek: [],
  });
}
```

**Note:** For the empty-data case, we should still query invoices and expenses since there could be revenue/expenses even without time entries. Move the invoice and expense queries to run regardless of whether `entriesWithRelations` has data — but keep the time-based buckets (`hoursByPeriod`, `utilizationByWeek`) empty when no entries exist.

**Step 5: Verify**

```bash
pnpm typecheck
```

Test manually: visit reports page, open Network tab, check analytics response includes new fields.

**Step 6: Commit**

```bash
git add app/api/v1/organizations/*/analytics/route.ts
git commit -m "feat(api): add time-series data to analytics endpoint"
```

---

## Task 3: Create hours-over-time chart component

**Files:**
- Create: `components/reports/hours-chart.tsx`

**References:**
- shadcn chart-bar-stacked example for stacked bar pattern
- `ChartContainer`, `ChartConfig`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent` from `components/ui/chart`
- `Bar`, `BarChart`, `CartesianGrid`, `XAxis`, `YAxis` from `recharts`

**Step 1: Create the component**

```tsx
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
  // "2026-02-05" → "Feb 5", "2026-02" → "Feb"
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
                  formatter={(value, name) => [`${value}h`, name === "billable" ? "Billable" : "Unbillable"]}
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
```

**Step 2: Verify**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add components/reports/hours-chart.tsx
git commit -m "feat(reports): add hours-over-time stacked bar chart"
```

---

## Task 4: Create revenue-over-time chart component

**Files:**
- Create: `components/reports/revenue-chart.tsx`

**References:**
- shadcn chart-area-stacked example for area pattern
- `Area`, `AreaChart`, `CartesianGrid`, `XAxis`, `YAxis` from `recharts`

**Step 1: Create the component**

```tsx
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
    ...(showExpenses && {
      expenses: {
        label: "Expenses",
        color: "var(--chart-3)",
      },
      profit: {
        label: "Profit",
        color: "var(--chart-4)",
      },
    }),
  };

  const chartData = data.map((d) => ({
    month: d.month,
    income: d.incomeCents / 100,
    expenses: d.expenseCents / 100,
    profit: (d.incomeCents - d.expenseCents) / 100,
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
              tickFormatter={(value) => `$${value.toLocaleString()}`}
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
```

**Step 2: Verify**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add components/reports/revenue-chart.tsx
git commit -m "feat(reports): add revenue-over-time area chart"
```

---

## Task 5: Create utilization-over-time chart component

**Files:**
- Create: `components/reports/utilization-chart.tsx`

**References:**
- shadcn chart-line-default example for line pattern
- `Line`, `LineChart`, `CartesianGrid`, `XAxis`, `YAxis`, `ReferenceLine` from `recharts`

**Step 1: Create the component**

```tsx
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
                  formatter={(value) => [`${value}%`, "Utilization"]}
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
```

**Step 2: Verify**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add components/reports/utilization-chart.tsx
git commit -m "feat(reports): add utilization trend line chart"
```

---

## Task 6: Upgrade time-breakdown with real bar chart

**Files:**
- Modify: `components/reports/time-breakdown.tsx`

Replace the custom `HorizontalBar` component with a shadcn horizontal bar chart. Keep all stat cards and the "Top Projects" list card untouched.

**Step 1: Replace the "Hours by Client" card**

Remove the `HorizontalBar` component. Replace the card content with a horizontal stacked `BarChart`:

- Each bar represents one client
- Two segments: billable (client color) and unbillable (client color at 40% opacity)
- Horizontal layout (`layout="vertical"`) so client names are Y-axis labels
- Tooltip shows client name, billable hours, unbillable hours
- Keep the legend at the bottom

The `ChartConfig` should be built dynamically from `clientBreakdown` data (each client gets its own color from `client.color`). However, for the stacked bars we use just two series (billable/unbillable) with the chart using a single color scheme per bar via custom rendering.

Simpler approach: use a standard horizontal bar chart with two data keys (billableHours, unbillableHours) and use `var(--chart-1)` / `var(--chart-2)` for all bars. Client names go on the Y-axis.

```tsx
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";

// Inside the component, replace the "Hours by Client" card content:
const clientChartConfig = {
  billable: { label: "Billable", color: "var(--chart-1)" },
  unbillable: { label: "Unbillable", color: "var(--chart-2)" },
} satisfies ChartConfig;

const clientChartData = clientBreakdown.map((c) => ({
  name: c.name,
  billable: +(c.billableMinutes / 60).toFixed(1),
  unbillable: +(c.unbillableMinutes / 60).toFixed(1),
}));
```

Replace the card body (the `clientBreakdown.map(...)` + legend) with:

```tsx
<ChartContainer config={clientChartConfig} className="aspect-auto w-full" style={{ height: Math.max(clientBreakdown.length * 48, 120) }}>
  <BarChart accessibilityLayer data={clientChartData} layout="vertical" margin={{ left: 8, right: 8 }}>
    <CartesianGrid horizontal={false} />
    <YAxis
      dataKey="name"
      type="category"
      tickLine={false}
      axisLine={false}
      width={100}
      tickFormatter={(value) => value.length > 14 ? value.slice(0, 14) + "..." : value}
    />
    <XAxis
      type="number"
      tickLine={false}
      axisLine={false}
      tickFormatter={(value) => `${value}h`}
    />
    <ChartTooltip
      content={<ChartTooltipContent formatter={(value) => `${value}h`} />}
    />
    <ChartLegend content={<ChartLegendContent />} />
    <Bar dataKey="billable" stackId="hours" fill="var(--color-billable)" radius={[0, 0, 0, 0]} />
    <Bar dataKey="unbillable" stackId="hours" fill="var(--color-unbillable)" radius={[0, 4, 4, 0]} />
  </BarChart>
</ChartContainer>
```

Remove the `HorizontalBar` function entirely. Remove unused imports if any.

**Step 2: Verify**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add components/reports/time-breakdown.tsx
git commit -m "feat(reports): replace custom bars with shadcn chart in time breakdown"
```

---

## Task 7: Upgrade invoice-status with real bar chart

**Files:**
- Modify: `components/reports/invoice-status.tsx`

Replace the custom `AgingBar` component with a horizontal bar chart. Keep stat cards and "Recent Activity" list untouched.

**Step 1: Replace the "Aging Breakdown" card**

Remove the `AgingBar` component. Replace with a horizontal `BarChart`:

```tsx
import { Bar, BarChart, XAxis, YAxis, CartesianGrid, Cell } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const agingConfig = {
  amount: { label: "Amount" },
  current: { label: "Current", color: "hsl(142, 71%, 45%)" },     // green
  days1to30: { label: "1-30 days", color: "hsl(48, 96%, 53%)" },  // yellow
  days31to60: { label: "31-60 days", color: "hsl(25, 95%, 53%)" },// orange
  days60plus: { label: "60+ days", color: "hsl(0, 84%, 60%)" },   // red
} satisfies ChartConfig;

const agingChartData = [
  { bucket: "Current", amount: aging.current / 100, fill: "var(--color-current)" },
  { bucket: "1-30 days", amount: aging.days1to30 / 100, fill: "var(--color-days1to30)" },
  { bucket: "31-60 days", amount: aging.days31to60 / 100, fill: "var(--color-days31to60)" },
  { bucket: "60+ days", amount: aging.days60plus / 100, fill: "var(--color-days60plus)" },
];
```

Card content:

```tsx
<ChartContainer config={agingConfig} className="aspect-auto h-[200px] w-full">
  <BarChart accessibilityLayer data={agingChartData} layout="vertical" margin={{ left: 8, right: 8 }}>
    <CartesianGrid horizontal={false} />
    <YAxis
      dataKey="bucket"
      type="category"
      tickLine={false}
      axisLine={false}
      width={80}
    />
    <XAxis
      type="number"
      tickLine={false}
      axisLine={false}
      tickFormatter={(value) => `$${value.toLocaleString()}`}
    />
    <ChartTooltip
      content={
        <ChartTooltipContent
          formatter={(value) => formatCurrency(Number(value) * 100)}
        />
      }
    />
    <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
      {agingChartData.map((entry) => (
        <Cell key={entry.bucket} fill={entry.fill} />
      ))}
    </Bar>
  </BarChart>
</ChartContainer>
```

Remove the `AgingBar` function entirely.

**Step 2: Verify**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add components/reports/invoice-status.tsx
git commit -m "feat(reports): replace custom bars with shadcn chart in invoice status"
```

---

## Task 8: Upgrade expense-breakdown with donut chart

**Files:**
- Modify: `components/reports/expense-breakdown.tsx`

Replace the custom `CategoryBar` component with a pie/donut chart. Keep stat cards and "Top Projects by Expense" list untouched.

**Step 1: Replace the "By Category" card**

Remove the `CategoryBar` component. Replace with a donut `PieChart`:

```tsx
import { Pie, PieChart, Cell } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";

// Build dynamic config from categories
const CATEGORY_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)",
  "var(--chart-4)", "var(--chart-5)",
];

const categoryConfig: ChartConfig = Object.fromEntries(
  byCategory.map((cat, i) => [
    cat.category,
    {
      label: cat.category.charAt(0).toUpperCase() + cat.category.slice(1),
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    },
  ])
);

const pieData = byCategory.map((cat, i) => ({
  name: cat.category,
  value: cat.amountCents / 100,
  fill: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
}));
```

Card content:

```tsx
<ChartContainer config={categoryConfig} className="aspect-square h-[250px] w-full">
  <PieChart>
    <ChartTooltip
      content={
        <ChartTooltipContent
          formatter={(value) => formatCurrency(Number(value) * 100)}
        />
      }
    />
    <Pie
      data={pieData}
      dataKey="value"
      nameKey="name"
      innerRadius={60}
      outerRadius={90}
      strokeWidth={2}
    >
      {pieData.map((entry) => (
        <Cell key={entry.name} fill={entry.fill} />
      ))}
    </Pie>
    <ChartLegend content={<ChartLegendContent nameKey="name" />} />
  </PieChart>
</ChartContainer>
```

Remove the `CategoryBar` function entirely.

**Step 2: Verify**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add components/reports/expense-breakdown.tsx
git commit -m "feat(reports): replace custom bars with donut chart in expense breakdown"
```

---

## Task 9: Wire trends into reports page

**Files:**
- Modify: `app/(app)/reports/reports-page-content.tsx`

**Step 1: Update the `TimeData` type to include new fields**

Add to the existing `TimeData` type:

```typescript
type TimeData = {
  // ...existing fields...
  hoursByPeriod: Array<{
    date: string;
    billableMinutes: number;
    unbillableMinutes: number;
  }>;
  revenueByMonth: Array<{
    month: string;
    incomeCents: number;
    expenseCents: number;
  }>;
  utilizationByWeek: Array<{
    weekStart: string;
    totalMinutes: number;
    billableMinutes: number;
    percentage: number;
  }>;
};
```

**Step 2: Import the new chart components**

```typescript
import { HoursChart } from "@/components/reports/hours-chart";
import { RevenueChart } from "@/components/reports/revenue-chart";
import { UtilizationChart } from "@/components/reports/utilization-chart";
```

**Step 3: Add the Trends section between FinancialSummary and TimeBreakdown**

In the overview tab rendering (inside `<div className="space-y-8">`), after `<FinancialSummary>` and before the TimeBreakdown conditional:

```tsx
{/* Trends */}
{timeData && (timeData.hoursByPeriod.length > 0 || timeData.revenueByMonth.length > 0 || timeData.utilizationByWeek.length > 0) && (
  <section className="space-y-4">
    <h2 className="text-lg font-semibold">Trends</h2>
    <HoursChart data={timeData.hoursByPeriod} />
    <div className="grid gap-4 lg:grid-cols-2">
      <RevenueChart
        data={timeData.revenueByMonth}
        showExpenses={features.expenses}
      />
      <UtilizationChart data={timeData.utilizationByWeek} />
    </div>
  </section>
)}
```

**Step 4: Verify**

```bash
pnpm typecheck
```

Test manually: reports page overview → should show trend charts between financial summary and time breakdown sections.

**Step 5: Commit**

```bash
git add app/(app)/reports/reports-page-content.tsx
git commit -m "feat(reports): add trends section with hours, revenue, and utilization charts"
```

---

## Task 10: Add table view to tasks page

**Files:**
- Modify: `app/(app)/tasks/tasks-content.tsx`

Currently supports `["list", "board"]` views. Add `"table"` to the views array and create a table view.

**Step 1: Update views array**

```typescript
const TASK_VIEWS = ["list", "board", "table"] as const;
```

**Step 2: Add table view rendering**

Below the existing `view === "board"` conditional, add:

```tsx
) : view === "table" ? (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Task</TableHead>
        <TableHead>Project</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Priority</TableHead>
        <TableHead className="text-right">Actions</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {/* Map filtered tasks to table rows */}
    </TableBody>
  </Table>
```

Import `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` from `@/components/ui/table`.

Adapt columns to match whatever fields tasks have. Follow the same pattern as the contracts/proposals/projects table views (status badges, action dropdowns with edit/delete).

**Step 3: Verify**

```bash
pnpm typecheck
```

**Step 4: Commit**

```bash
git add app/(app)/tasks/tasks-content.tsx
git commit -m "feat(tasks): add table view"
```

---

## Task 11: Add table view to clients page

**Files:**
- Modify: `app/(app)/clients/clients-content.tsx`

Currently supports `["list"]` only. Add `"table"`.

**Step 1: Update views array**

```typescript
const CLIENT_VIEWS = ["list", "table"] as const;
```

**Step 2: Add table view**

Table columns: Color dot + Name, Contact/Email, Projects count, Rate, Billable status, Actions.

Follow the same table patterns from contracts/proposals/projects.

**Step 3: Verify and commit**

```bash
pnpm typecheck
git add app/(app)/clients/clients-content.tsx
git commit -m "feat(clients): add table view"
```

---

## Task 12: Add table view to expenses page

**Files:**
- Modify: `components/expenses/expense-timeline.tsx`

Currently supports `["timeline"]` only. Add `"table"`.

**Step 1: Update views array**

```typescript
const EXPENSE_VIEWS = ["timeline", "table"] as const;
```

**Step 2: Add table view**

Table columns: Date, Description, Category, Project, Amount, Billable, Receipt, Actions.

Render below the toolbar conditionally: `view === "timeline" ? (existing timeline) : (table view)`.

**Step 3: Verify and commit**

```bash
pnpm typecheck
git add components/expenses/expense-timeline.tsx
git commit -m "feat(expenses): add table view"
```

---

## Task 13: Add table view to track/timeline page

**Files:**
- Modify: `components/timeline/timeline.tsx`

Currently supports `["timeline"]` only. Add `"table"`.

**Step 1: Update views array**

```typescript
const TRACK_VIEWS = ["timeline", "table"] as const;
```

**Step 2: Add table view**

Table columns: Date, Client, Project, Task, Description, Duration, Billable, Actions.

Render conditionally alongside existing timeline view.

**Step 3: Verify and commit**

```bash
pnpm typecheck
git add components/timeline/timeline.tsx
git commit -m "feat(track): add table view"
```

---

## Verification checklist

After all tasks are complete:

1. `pnpm typecheck` passes
2. Reports page: Financial Summary stat cards unchanged
3. Reports page: Trends section appears with 3 charts (hours bar, revenue area, utilization line)
4. Reports page: Time Breakdown uses real horizontal bar chart instead of custom divs
5. Reports page: Invoice Status uses real bar chart for aging
6. Reports page: Expense Breakdown uses donut chart for categories
7. Reports page: Project Health unchanged (progress bars kept)
8. All pages have working table view toggle in ViewSwitcher
9. View preference persists in localStorage per page
10. Date range picker still controls all report data including charts
