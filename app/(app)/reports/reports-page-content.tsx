"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { Loader2 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DateRangePicker, type Period } from "@/components/reports/date-range-picker";
import { FinancialSummary } from "@/components/reports/financial-summary";
import { TimeBreakdown } from "@/components/reports/time-breakdown";
import { InvoiceStatus } from "@/components/reports/invoice-status";
import { ExpenseBreakdown } from "@/components/reports/expense-breakdown";
import { ProjectHealth } from "@/components/reports/project-health";
import { ReportConfigs } from "@/components/reports/report-configs";
import { AccountingTab } from "@/components/reports/accounting-tab";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";

type ReportsPageContentProps = {
  orgId: string;
  features?: OrgFeatures;
};

type TimeData = {
  totalMinutes: number;
  totalBillable: number;
  totalUnbillableMinutes: number;
  clientBreakdown: Array<{
    id: string;
    name: string;
    color: string | null;
    totalMinutes: number;
    billableMinutes: number;
    unbillableMinutes: number;
    totalAmount: number;
  }>;
  topProjects?: Array<{
    id: string;
    name: string;
    clientName: string;
    totalMinutes: number;
    totalAmount: number;
  }>;
};

type InvoiceData = {
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
  recentActivity: Array<{
    invoiceId: string;
    invoiceNumber: string;
    clientName: string;
    event: "paid" | "sent" | "viewed";
    amount: number;
    date: string;
  }>;
};

type ExpenseData = {
  totalCents: number;
  billableCents: number;
  nonBillableCents: number;
  byCategory: Array<{
    category: string;
    amountCents: number;
  }>;
  byProject: Array<{
    id: string;
    name: string;
    clientName: string;
    amountCents: number;
  }>;
  recoveryRate: number;
};

type ProjectData = {
  activeCount: number;
  onBudgetCount: number;
  atRiskCount: number;
  overBudgetCount: number;
  projectsWithBudgets: Array<{
    id: string;
    name: string;
    clientName: string;
    clientColor: string | null;
    budgetType: string;
    budgetValue: number;
    usedValue: number;
    usedPercentage: number;
    status: "on_budget" | "at_risk" | "over_budget";
  }>;
  projectsWithoutBudgets: Array<{
    id: string;
    name: string;
    clientName: string;
    clientColor: string | null;
    totalMinutes: number;
  }>;
};

function buildDateParams(period: Period, customRange: DateRange | undefined): string {
  if (period === "custom" && customRange?.from) {
    const fromStr = format(customRange.from, "yyyy-MM-dd");
    const toStr = customRange.to
      ? format(customRange.to, "yyyy-MM-dd")
      : fromStr;
    return `from=${fromStr}&to=${toStr}`;
  }
  return `period=${period}`;
}

export function ReportsPageContent({
  orgId,
  features = DEFAULT_ORG_FEATURES,
}: ReportsPageContentProps): React.ReactElement {
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentTab = searchParams.get("tab") || "overview";

  function setTab(tab: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.push(`/reports?${params.toString()}`);
  }

  const [period, setPeriod] = useState<Period>("month");
  const [customRange, setCustomRange] = useState<DateRange | undefined>();

  const [timeData, setTimeData] = useState<TimeData | null>(null);
  const [invoiceData, setInvoiceData] = useState<InvoiceData | null>(null);
  const [expenseData, setExpenseData] = useState<ExpenseData | null>(null);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const dateParams = buildDateParams(period, customRange);

    async function loadData(): Promise<void> {
      setIsLoading(true);

      const results = await Promise.all([
        features.time_tracking
          ? fetch(`/api/v1/organizations/${orgId}/analytics?${dateParams}`)
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null)
          : Promise.resolve(null),
        features.invoicing
          ? fetch(`/api/v1/organizations/${orgId}/reports/invoices?${dateParams}`)
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null)
          : Promise.resolve(null),
        features.expenses
          ? fetch(`/api/v1/organizations/${orgId}/reports/expenses?${dateParams}`)
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null)
          : Promise.resolve(null),
        features.pm
          ? fetch(`/api/v1/organizations/${orgId}/reports/projects?${dateParams}`)
              .then((res) => (res.ok ? res.json() : null))
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      if (cancelled) return;

      setTimeData(results[0]);
      setInvoiceData(results[1]);
      setExpenseData(results[2]);
      setProjectData(results[3]);
      setIsLoading(false);
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, [orgId, period, customRange, features]);

  const revenue = features.invoicing && invoiceData
    ? invoiceData.paid
    : timeData?.totalBillable ?? 0;

  const revenueSource: "invoices" | "billable_time" =
    features.invoicing && invoiceData ? "invoices" : "billable_time";

  const hasNoData =
    !timeData && !invoiceData && !expenseData && !projectData;

  return (
    <Tabs value={currentTab} onValueChange={setTab} className="space-y-6">
      <TabsList className="squircle">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="accounting">Accounting</TabsTrigger>
        <TabsTrigger value="client-reports">Client Reports</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="space-y-8">
        <DateRangePicker
          period={period}
          customRange={customRange}
          onPeriodChange={setPeriod}
          onCustomRangeChange={setCustomRange}
        />

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : hasNoData ? (
          <div className="py-12 text-center">
            <p className="text-muted-foreground">
              No data available for this period.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            <FinancialSummary
              revenue={revenue}
              revenueSource={revenueSource}
              expenses={expenseData?.totalCents}
              outstanding={invoiceData ? invoiceData.pending + invoiceData.overdue : undefined}
              features={features}
            />

            {features.time_tracking && timeData && (
              <TimeBreakdown
                totalMinutes={timeData.totalMinutes}
                totalBillable={timeData.totalBillable}
                totalUnbillableMinutes={timeData.totalUnbillableMinutes}
                clientBreakdown={timeData.clientBreakdown}
                topProjects={timeData.topProjects}
              />
            )}

            {features.invoicing && invoiceData && (
              <InvoiceStatus
                paid={invoiceData.paid}
                pending={invoiceData.pending}
                overdue={invoiceData.overdue}
                draft={invoiceData.draft}
                aging={invoiceData.aging}
                recentActivity={invoiceData.recentActivity}
              />
            )}

            {features.expenses && expenseData && (
              <ExpenseBreakdown
                totalCents={expenseData.totalCents}
                billableCents={expenseData.billableCents}
                nonBillableCents={expenseData.nonBillableCents}
                byCategory={expenseData.byCategory}
                byProject={expenseData.byProject}
                recoveryRate={expenseData.recoveryRate}
              />
            )}

            {features.pm && projectData && (
              <ProjectHealth
                activeCount={projectData.activeCount}
                onBudgetCount={projectData.onBudgetCount}
                atRiskCount={projectData.atRiskCount}
                overBudgetCount={projectData.overBudgetCount}
                projectsWithBudgets={projectData.projectsWithBudgets}
                projectsWithoutBudgets={projectData.projectsWithoutBudgets}
              />
            )}
          </div>
        )}
      </TabsContent>

      <TabsContent value="accounting">
        <AccountingTab orgId={orgId} />
      </TabsContent>

      <TabsContent value="client-reports">
        <ReportConfigs orgId={orgId} />
      </TabsContent>
    </Tabs>
  );
}
