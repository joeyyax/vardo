import { CheckCircle, Clock, AlertTriangle, FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

function AgingBar({
  label,
  amount,
  maxAmount,
  colorClass,
}: {
  label: string;
  amount: number;
  maxAmount: number;
  colorClass: string;
}) {
  const percentage = maxAmount > 0 ? (amount / maxAmount) * 100 : 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="font-medium">{formatCurrency(amount)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full transition-all ${colorClass}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
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
  const maxAgingAmount = Math.max(
    aging.current,
    aging.days1to30,
    aging.days31to60,
    aging.days60plus,
    1
  );

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
          <CardContent className="space-y-4">
            <AgingBar
              label="Current"
              amount={aging.current}
              maxAmount={maxAgingAmount}
              colorClass="bg-green-500"
            />
            <AgingBar
              label="1-30 days"
              amount={aging.days1to30}
              maxAmount={maxAgingAmount}
              colorClass="bg-yellow-500"
            />
            <AgingBar
              label="31-60 days"
              amount={aging.days31to60}
              maxAmount={maxAgingAmount}
              colorClass="bg-orange-500"
            />
            <AgingBar
              label="60+ days"
              amount={aging.days60plus}
              maxAmount={maxAgingAmount}
              colorClass="bg-red-500"
            />
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
