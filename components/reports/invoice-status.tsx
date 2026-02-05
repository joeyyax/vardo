import { CheckCircle, Clock, AlertTriangle, FileText } from "lucide-react";
import { Bar, BarChart, XAxis, YAxis, CartesianGrid, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

type RecentActivity = {
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  event: "paid" | "sent" | "viewed";
  amount: number;
  date: string;
};

type InvoiceStatusProps = {
  paid: number;
  pending: number;
  overdue: number;
  draft: number;
  aging: {
    current: number;
    days1to30: number;
    days31to60: number;
    days60plus: number;
  };
  recentActivity: RecentActivity[];
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function StatCard({
  icon: Icon,
  label,
  value,
  iconClassName,
  valueClassName,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  iconClassName?: string;
  valueClassName?: string;
}) {
  return (
    <Card className="squircle">
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-muted p-2">
            <Icon className={`size-5 ${iconClassName ?? "text-muted-foreground"}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className={`text-2xl font-semibold ${valueClassName ?? ""}`}>
              {value}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function getEventIcon(event: RecentActivity["event"]): {
  icon: React.ElementType;
  className: string;
} {
  switch (event) {
    case "paid":
      return { icon: CheckCircle, className: "text-green-600" };
    case "sent":
      return { icon: FileText, className: "text-blue-600" };
    case "viewed":
      return { icon: Clock, className: "text-amber-600" };
  }
}

function getEventLabel(event: RecentActivity["event"]): string {
  switch (event) {
    case "paid":
      return "Paid";
    case "sent":
      return "Sent";
    case "viewed":
      return "Viewed";
  }
}

export function InvoiceStatus({
  paid,
  pending,
  overdue,
  draft,
  aging,
  recentActivity,
}: InvoiceStatusProps) {
  const agingConfig = {
    amount: { label: "Amount" },
    current: { label: "Current", color: "hsl(142, 71%, 45%)" },
    days1to30: { label: "1-30 days", color: "hsl(48, 96%, 53%)" },
    days31to60: { label: "31-60 days", color: "hsl(25, 95%, 53%)" },
    days60plus: { label: "60+ days", color: "hsl(0, 84%, 60%)" },
  } satisfies ChartConfig;

  const agingChartData = [
    { bucket: "Current", amount: aging.current / 100, fill: "var(--color-current)" },
    { bucket: "1-30 days", amount: aging.days1to30 / 100, fill: "var(--color-days1to30)" },
    { bucket: "31-60 days", amount: aging.days31to60 / 100, fill: "var(--color-days31to60)" },
    { bucket: "60+ days", amount: aging.days60plus / 100, fill: "var(--color-days60plus)" },
  ];

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Invoice Status</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={CheckCircle}
          label="Paid"
          value={formatCurrency(paid)}
          iconClassName="text-green-600"
          valueClassName="text-green-600"
        />
        <StatCard
          icon={Clock}
          label="Pending"
          value={formatCurrency(pending)}
        />
        <StatCard
          icon={AlertTriangle}
          label="Overdue"
          value={formatCurrency(overdue)}
          iconClassName="text-red-600"
          valueClassName="text-red-600"
        />
        <StatCard
          icon={FileText}
          label="Draft"
          value={formatCurrency(draft)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-base">Aging Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={agingConfig} className="aspect-auto h-[200px] w-full">
              <BarChart
                accessibilityLayer
                data={agingChartData}
                layout="vertical"
                margin={{ left: 8, right: 8 }}
              >
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
                  tickFormatter={(value) => `$${Number(value).toLocaleString()}`}
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
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity</p>
            ) : (
              <div className="space-y-3">
                {recentActivity.map((activity) => {
                  const { icon: EventIcon, className: iconClassName } =
                    getEventIcon(activity.event);
                  return (
                    <div
                      key={`${activity.invoiceId}-${activity.event}`}
                      className="flex items-center gap-3"
                    >
                      <EventIcon className={`size-4 shrink-0 ${iconClassName}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {activity.invoiceNumber} - {activity.clientName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {getEventLabel(activity.event)} -{" "}
                          {formatCurrency(activity.amount)}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {activity.date}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
