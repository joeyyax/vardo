import { Receipt, CircleDollarSign, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type CategoryExpense = {
  category: string;
  amountCents: number;
};

type ProjectExpense = {
  id: string;
  name: string;
  clientName: string;
  amountCents: number;
};

type ExpenseBreakdownProps = {
  totalCents: number;
  billableCents: number;
  nonBillableCents: number;
  byCategory: CategoryExpense[];
  byProject: ProjectExpense[];
  recoveryRate: number;
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
  subtitle,
  iconClassName,
  valueClassName,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  subtitle?: string;
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
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CategoryBar({
  category,
  amount,
  maxAmount,
}: {
  category: string;
  amount: number;
  maxAmount: number;
}) {
  const percentage = maxAmount > 0 ? (amount / maxAmount) * 100 : 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="capitalize">{category}</span>
        <span className="font-medium">{formatCurrency(amount)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

export function ExpenseBreakdown({
  totalCents,
  billableCents,
  nonBillableCents,
  byCategory,
  byProject,
  recoveryRate,
}: ExpenseBreakdownProps) {
  const maxCategoryAmount = Math.max(
    ...byCategory.map((c) => c.amountCents),
    1
  );

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Expense Breakdown</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Receipt}
          label="Total Expenses"
          value={formatCurrency(totalCents)}
        />
        <StatCard
          icon={CircleDollarSign}
          label="Billable"
          value={formatCurrency(billableCents)}
          iconClassName="text-green-600"
          valueClassName="text-green-600"
        />
        <StatCard
          icon={Receipt}
          label="Non-billable"
          value={formatCurrency(nonBillableCents)}
        />
        <StatCard
          icon={TrendingUp}
          label="Recovery Rate"
          value={`${Math.round(recoveryRate)}%`}
          subtitle="Billable / Total"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-base">By Category</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {byCategory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No expenses recorded</p>
            ) : (
              byCategory.map((item) => (
                <CategoryBar
                  key={item.category}
                  category={item.category}
                  amount={item.amountCents}
                  maxAmount={maxCategoryAmount}
                />
              ))
            )}
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-base">Top Projects by Expense</CardTitle>
          </CardHeader>
          <CardContent>
            {byProject.length === 0 ? (
              <p className="text-sm text-muted-foreground">No project expenses</p>
            ) : (
              <div className="space-y-3">
                {byProject.map((project) => (
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
                    <span className="font-medium shrink-0 ml-4">
                      {formatCurrency(project.amountCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
