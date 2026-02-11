import { Clock, DollarSign, ClockArrowDown, Percent } from "lucide-react";
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatHoursHuman as formatDuration } from "@/lib/formatting";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";

type ClientBreakdown = {
  id: string;
  name: string;
  color: string | null;
  totalMinutes: number;
  billableMinutes: number;
  unbillableMinutes: number;
  totalAmount: number;
};

type TopProject = {
  id: string;
  name: string;
  clientName: string;
  totalMinutes: number;
  totalAmount: number;
};

type TimeBreakdownProps = {
  totalMinutes: number;
  totalBillable: number;
  totalUnbillableMinutes: number;
  clientBreakdown: ClientBreakdown[];
  topProjects?: TopProject[];
};

function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <Card className="squircle">
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-muted p-2">
            <Icon className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-semibold">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function TimeBreakdown({
  totalMinutes,
  totalBillable,
  totalUnbillableMinutes,
  clientBreakdown,
  topProjects,
}: TimeBreakdownProps) {
  const billableMinutes = totalMinutes - totalUnbillableMinutes;
  const utilization =
    totalMinutes > 0 ? Math.round((billableMinutes / totalMinutes) * 100) : 0;

  const clientChartConfig = {
    billable: { label: "Billable", color: "var(--chart-1)" },
    unbillable: { label: "Unbillable", color: "var(--chart-2)" },
  } satisfies ChartConfig;

  const clientChartData = clientBreakdown.map((c) => ({
    name: c.name,
    billable: +(c.billableMinutes / 60).toFixed(1),
    unbillable: +(c.unbillableMinutes / 60).toFixed(1),
  }));

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Time Breakdown</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Clock}
          label="Total Time"
          value={formatDuration(totalMinutes)}
        />
        <StatCard
          icon={DollarSign}
          label="Billable Amount"
          value={formatCurrency(totalBillable)}
        />
        <StatCard
          icon={ClockArrowDown}
          label="Unbillable Time"
          value={formatDuration(totalUnbillableMinutes)}
        />
        <StatCard
          icon={Percent}
          label="Utilization"
          value={`${utilization}%`}
          subtitle="Billable / Total"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-base">Hours by Client</CardTitle>
          </CardHeader>
          <CardContent>
            {clientBreakdown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data available</p>
            ) : (
              <ChartContainer
                config={clientChartConfig}
                className="aspect-auto w-full"
                style={{ height: Math.max(clientBreakdown.length * 48, 120) }}
              >
                <BarChart
                  accessibilityLayer
                  data={clientChartData}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    tickLine={false}
                    axisLine={false}
                    width={100}
                    tickFormatter={(value) =>
                      value.length > 14 ? value.slice(0, 14) + "..." : value
                    }
                  />
                  <XAxis
                    type="number"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `${value}h`}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) => `${value}h`}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar
                    dataKey="billable"
                    stackId="hours"
                    fill="var(--color-billable)"
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="unbillable"
                    stackId="hours"
                    fill="var(--color-unbillable)"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {topProjects && topProjects.length > 0 && (
          <Card className="squircle">
            <CardHeader>
              <CardTitle className="text-base">Top Projects</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {topProjects.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{project.name}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {project.clientName}
                      </p>
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      <p className="font-medium">
                        {formatDuration(project.totalMinutes)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {formatCurrency(project.totalAmount)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}
