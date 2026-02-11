import {
  DollarSign,
  Receipt,
  TrendingUp,
  TrendingDown,
  AlertCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/formatting";
import type { OrgFeatures } from "@/lib/db/schema";

type FinancialSummaryProps = {
  revenue: number;
  revenueSource: "invoices" | "billable_time";
  expenses?: number;
  outstanding?: number;
  features: OrgFeatures;
};

function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
  valueClassName,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  subtitle?: string;
  valueClassName?: string;
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

export function FinancialSummary({
  revenue,
  revenueSource,
  expenses,
  outstanding,
  features,
}: FinancialSummaryProps) {
  const showExpenses = features.expenses && expenses !== undefined;
  const showOutstanding = features.invoicing && outstanding !== undefined;

  const margin = showExpenses ? revenue - expenses! : 0;
  const marginPercentage =
    showExpenses && revenue > 0 ? Math.round((margin / revenue) * 100) : 0;
  const isPositiveMargin = margin >= 0;

  const revenueSubtitle =
    revenueSource === "invoices" ? "From invoices" : "Billable time";

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Financial Summary</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label="Revenue"
          value={formatCurrency(revenue)}
          subtitle={revenueSubtitle}
        />

        {showExpenses && (
          <StatCard
            icon={Receipt}
            label="Expenses"
            value={formatCurrency(expenses!)}
          />
        )}

        {showExpenses && (
          <StatCard
            icon={isPositiveMargin ? TrendingUp : TrendingDown}
            label="Margin"
            value={formatCurrency(margin)}
            subtitle={`${marginPercentage}%`}
            valueClassName={isPositiveMargin ? "text-green-600" : "text-red-600"}
          />
        )}

        {showOutstanding && (
          <StatCard
            icon={AlertCircle}
            label="Outstanding"
            value={formatCurrency(outstanding!)}
          />
        )}
      </div>
    </section>
  );
}
