import { Clock, DollarSign, ClockArrowDown, Percent } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

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

function HorizontalBar({
  billablePercent,
  unbillablePercent,
  color,
}: {
  billablePercent: number;
  unbillablePercent: number;
  color: string | null;
}) {
  const barColor = color ?? "#6b7280";

  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full transition-all"
        style={{
          width: `${billablePercent}%`,
          backgroundColor: barColor,
        }}
      />
      <div
        className="h-full transition-all opacity-40"
        style={{
          width: `${unbillablePercent}%`,
          backgroundColor: barColor,
        }}
      />
    </div>
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

  const maxClientMinutes = Math.max(
    ...clientBreakdown.map((c) => c.totalMinutes),
    1
  );

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
          <CardContent className="space-y-4">
            {clientBreakdown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data available</p>
            ) : (
              clientBreakdown.map((client) => {
                const billablePercent =
                  (client.billableMinutes / maxClientMinutes) * 100;
                const unbillablePercent =
                  (client.unbillableMinutes / maxClientMinutes) * 100;

                return (
                  <div key={client.id} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        {client.color && (
                          <div
                            className="size-2.5 rounded-full"
                            style={{ backgroundColor: client.color }}
                          />
                        )}
                        <span className="font-medium">{client.name}</span>
                      </div>
                      <span className="text-muted-foreground">
                        {formatDuration(client.totalMinutes)}
                      </span>
                    </div>
                    <HorizontalBar
                      billablePercent={billablePercent}
                      unbillablePercent={unbillablePercent}
                      color={client.color}
                    />
                  </div>
                );
              })
            )}
            <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2">
              <div className="flex items-center gap-1">
                <div className="size-2.5 rounded-full bg-primary" />
                <span>Billable</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="size-2.5 rounded-full bg-primary/40" />
                <span>Unbillable</span>
              </div>
            </div>
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
