"use client";

import { useState, useEffect } from "react";
import { getYear } from "date-fns";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Receipt,
  DollarSign,
  TrendingUp,
  Clock,
  Download,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { RevenueChart } from "@/components/reports/revenue-chart";

type AccountingTabProps = {
  orgId: string;
  clientId?: string | null;
  setClientId?: (id: string | null) => void;
  clients?: { id: string; name: string; color: string | null }[];
  projects?: { id: string; name: string; clientId: string }[];
  filteredProjects?: { id: string; name: string; clientId: string }[];
};

type AccountingData = {
  expenses: {
    totalCents: number;
    count: number;
  };
  income: {
    totalCents: number;
    hoursTracked: number;
  };
  profit: {
    totalCents: number;
    margin: number;
  };
  outstanding: {
    totalCents: number;
    invoiceCount: number;
  };
  yearInReview?: {
    hoursTracked: number;
    clientCount: number;
    topClient: { name: string; hours: number; amount: number } | null;
  };
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function getDefaultYear(): string {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  // Before April 15, default to previous year (tax season)
  if (month < 3 || (month === 3 && now.getDate() < 15)) {
    return (year - 1).toString();
  }
  return year.toString();
}

export function AccountingTab({ orgId }: AccountingTabProps) {
  const [selectedYear, setSelectedYear] = useState<string>(getDefaultYear());
  const [data, setData] = useState<AccountingData | null>(null);
  const [revenueByMonth, setRevenueByMonth] = useState<
    { month: string; incomeCents: number; expenseCents: number }[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);

  const currentYear = getYear(new Date());
  const years = Array.from({ length: 5 }, (_, i) => (currentYear - i).toString());

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);

      const startDate = `${selectedYear}-01-01`;
      const endDate = `${selectedYear}-12-31`;

      try {
        const [expensesRes, analyticsRes, invoicesRes] = await Promise.all([
          fetch(`/api/v1/organizations/${orgId}/reports/expenses?from=${startDate}&to=${endDate}`),
          fetch(`/api/v1/organizations/${orgId}/analytics?from=${startDate}&to=${endDate}`),
          fetch(`/api/v1/organizations/${orgId}/reports/invoices?from=${startDate}&to=${endDate}`),
        ]);

        const expenses = expensesRes.ok ? await expensesRes.json() : null;
        const analytics = analyticsRes.ok ? await analyticsRes.json() : null;
        const invoices = invoicesRes.ok ? await invoicesRes.json() : null;

        const totalExpenses = expenses?.totalCents || 0;
        const totalIncome = invoices?.paid || analytics?.totalBillable || 0;

        setRevenueByMonth(analytics?.revenueByMonth || []);

        setData({
          expenses: {
            totalCents: totalExpenses,
            count: expenses?.byCategory?.length || 0,
          },
          income: {
            totalCents: totalIncome,
            hoursTracked: Math.round((analytics?.totalMinutes || 0) / 60),
          },
          profit: {
            totalCents: totalIncome - totalExpenses,
            margin: totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0,
          },
          outstanding: {
            totalCents: (invoices?.pending || 0) + (invoices?.overdue || 0),
            invoiceCount: 0,
          },
          yearInReview: analytics ? {
            hoursTracked: Math.round((analytics.totalMinutes || 0) / 60),
            clientCount: analytics.clientBreakdown?.length || 0,
            topClient: analytics.clientBreakdown?.[0] ? {
              name: analytics.clientBreakdown[0].name,
              hours: Math.round(analytics.clientBreakdown[0].totalMinutes / 60),
              amount: analytics.clientBreakdown[0].totalAmount,
            } : null,
          } : undefined,
        });
      } catch (error) {
        console.error("Error fetching accounting data:", error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, [orgId, selectedYear]);

  function handleExportExpenses() {
    const startDate = `${selectedYear}-01-01`;
    const endDate = `${selectedYear}-12-31`;
    window.open(
      `/api/v1/organizations/${orgId}/expenses/export?startDate=${startDate}&endDate=${endDate}`,
      "_blank"
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">Tax Year:</span>
        <Select value={selectedYear} onValueChange={setSelectedYear}>
          <SelectTrigger className="w-[120px] squircle">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="squircle">
            {years.map((year) => (
              <SelectItem key={year} value={year}>
                {year}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="squircle">
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-red-100 dark:bg-red-900/30 p-2">
                      <Receipt className="size-5 text-red-600 dark:text-red-400" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Expenses</p>
                      <p className="text-2xl font-semibold">
                        {formatCurrency(data.expenses.totalCents)}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="squircle"
                    >
                      <Link href={`/expenses?startDate=${selectedYear}-01-01&endDate=${selectedYear}-12-31`}>
                        <ExternalLink className="size-4" />
                        View
                      </Link>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleExportExpenses}
                      className="squircle"
                    >
                      <Download className="size-4" />
                      Export
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-green-100 dark:bg-green-900/30 p-2">
                      <DollarSign className="size-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Income</p>
                      <p className="text-2xl font-semibold text-green-600 dark:text-green-400">
                        {formatCurrency(data.income.totalCents)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {data.income.hoursTracked.toLocaleString()} hours tracked
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-blue-100 dark:bg-blue-900/30 p-2">
                    <TrendingUp className="size-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Profit</p>
                    <p className={`text-2xl font-semibold ${data.profit.totalCents >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                      {formatCurrency(data.profit.totalCents)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {data.profit.margin.toFixed(1)}% margin
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-amber-100 dark:bg-amber-900/30 p-2">
                      <Clock className="size-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Outstanding</p>
                      <p className="text-2xl font-semibold text-amber-600 dark:text-amber-400">
                        {formatCurrency(data.outstanding.totalCents)}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="squircle"
                  >
                    <Link href="/invoices?status=pending">
                      <ExternalLink className="size-4" />
                      View
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <RevenueChart data={revenueByMonth} showExpenses={true} />

          {data.yearInReview && (
            <Card className="squircle">
              <CardContent className="pt-6">
                <h3 className="font-medium mb-3">Year in Review: {selectedYear}</h3>
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>
                    You tracked{" "}
                    <span className="font-medium text-foreground">
                      {data.yearInReview.hoursTracked.toLocaleString()} hours
                    </span>{" "}
                    across{" "}
                    <span className="font-medium text-foreground">
                      {data.yearInReview.clientCount} clients
                    </span>
                    .
                  </p>
                  {data.yearInReview.topClient && (
                    <p>
                      Top client:{" "}
                      <span className="font-medium text-foreground">
                        {data.yearInReview.topClient.name}
                      </span>{" "}
                      ({data.yearInReview.topClient.hours} hrs,{" "}
                      {formatCurrency(data.yearInReview.topClient.amount)})
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <p className="text-center text-muted-foreground py-12">
          No data available for {selectedYear}.
        </p>
      )}
    </div>
  );
}
