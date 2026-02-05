"use client";

import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { Loader2, X } from "lucide-react";
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
import { HoursChart } from "@/components/reports/hours-chart";
import { RevenueChart } from "@/components/reports/revenue-chart";
import { UtilizationChart } from "@/components/reports/utilization-chart";
import { PageToolbar } from "@/components/page-toolbar";
import { SavedReportsDropdown } from "@/components/reports/saved-reports-dropdown";
import { ExportDropdown } from "@/components/reports/export-dropdown";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

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

type ClientOption = { id: string; name: string; color: string | null };
type ProjectOption = { id: string; name: string; clientId: string };

function buildDateParams(
  period: Period,
  customRange: DateRange | undefined,
  clientId: string | null,
  projectId: string | null,
): string {
  let params: string;
  if (period === "custom" && customRange?.from) {
    const fromStr = format(customRange.from, "yyyy-MM-dd");
    const toStr = customRange.to
      ? format(customRange.to, "yyyy-MM-dd")
      : fromStr;
    params = `from=${fromStr}&to=${toStr}`;
  } else {
    params = `period=${period}`;
  }
  if (clientId) params += `&clientId=${clientId}`;
  if (projectId) params += `&projectId=${projectId}`;
  return params;
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

  // Client/project filter state
  const [clientId, setClientId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);

  // When client changes, reset project (project depends on client)
  function handleClientChange(value: string) {
    const newClientId = value === "all" ? null : value;
    setClientId(newClientId);
    setProjectId(null);
  }

  function handleProjectChange(value: string) {
    setProjectId(value === "all" ? null : value);
  }

  function clearFilters() {
    setClientId(null);
    setProjectId(null);
  }

  const hasActiveFilters = clientId !== null || projectId !== null;

  // Filter projects by selected client
  const filteredProjects = useMemo(() => {
    if (!clientId) return projects;
    return projects.filter((p) => p.clientId === clientId);
  }, [projects, clientId]);

  // Fetch clients and projects on mount
  useEffect(() => {
    async function fetchOptions() {
      const [clientsRes, projectsRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/clients`).catch(() => null),
        fetch(`/api/v1/organizations/${orgId}/projects`).catch(() => null),
      ]);

      if (clientsRes?.ok) {
        const data = await clientsRes.json();
        const list = Array.isArray(data) ? data : data.clients ?? [];
        setClients(
          list.map((c: { id: string; name: string; color?: string | null }) => ({
            id: c.id,
            name: c.name,
            color: c.color ?? null,
          }))
        );
      }

      if (projectsRes?.ok) {
        const data = await projectsRes.json();
        const list = Array.isArray(data) ? data : data.projects ?? [];
        setProjects(
          list.map((p: { id: string; name: string; clientId?: string; client_id?: string }) => ({
            id: p.id,
            name: p.name,
            clientId: p.clientId ?? p.client_id ?? "",
          }))
        );
      }
    }

    fetchOptions();
  }, [orgId]);

  const [timeData, setTimeData] = useState<TimeData | null>(null);
  const [invoiceData, setInvoiceData] = useState<InvoiceData | null>(null);
  const [expenseData, setExpenseData] = useState<ExpenseData | null>(null);
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const dateParams = buildDateParams(period, customRange, clientId, projectId);

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
  }, [orgId, period, customRange, clientId, projectId, features]);

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
        <PageToolbar
          actions={
            <>
              <SavedReportsDropdown
                orgId={orgId}
                currentTab="overview"
                currentFilters={{
                  period,
                  clientId,
                  projectId,
                  ...(period === "custom" && customRange ? {
                    customFrom: customRange.from?.toISOString(),
                    customTo: customRange.to?.toISOString(),
                  } : {}),
                }}
                onApplyPreset={(filters) => {
                  setPeriod((filters.period as Period) || "month");
                  setClientId((filters.clientId as string) || null);
                  setProjectId((filters.projectId as string) || null);
                  if (filters.customFrom && filters.customTo) {
                    setCustomRange({
                      from: new Date(filters.customFrom as string),
                      to: new Date(filters.customTo as string),
                    });
                  } else {
                    setCustomRange(undefined);
                  }
                }}
              />
              <ExportDropdown
                orgId={orgId}
                tab="overview"
                params={{
                  period: period !== "custom" ? period : undefined,
                  from: period === "custom" && customRange?.from ? format(customRange.from, "yyyy-MM-dd") : undefined,
                  to: period === "custom" && customRange?.to ? format(customRange.to, "yyyy-MM-dd") : undefined,
                  clientId,
                  projectId,
                }}
              />
            </>
          }
        >
          <DateRangePicker
            period={period}
            customRange={customRange}
            onPeriodChange={setPeriod}
            onCustomRangeChange={setCustomRange}
          />

          <Select value={clientId || "all"} onValueChange={handleClientChange}>
            <SelectTrigger className="w-[180px] squircle">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All Clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="flex items-center gap-2">
                    {c.color && (
                      <div
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: c.color }}
                      />
                    )}
                    {c.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={projectId || "all"} onValueChange={handleProjectChange}>
            <SelectTrigger className="w-[180px] squircle">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All Projects</SelectItem>
              {filteredProjects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="squircle"
            >
              <X className="size-4" />
              Clear
            </Button>
          )}
        </PageToolbar>

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
        <AccountingTab
          orgId={orgId}
          clientId={clientId}
          setClientId={setClientId}
          clients={clients}
          projects={projects}
          filteredProjects={filteredProjects}
        />
      </TabsContent>

      <TabsContent value="client-reports">
        <ReportConfigs orgId={orgId} />
      </TabsContent>
    </Tabs>
  );
}
