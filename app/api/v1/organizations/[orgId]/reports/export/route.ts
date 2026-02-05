import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  timeEntries,
  clients,
  projects,
  tasks,
  invoices,
  projectExpenses,
} from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import {
  format,
  startOfWeek,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  endOfWeek,
  endOfMonth,
  endOfQuarter,
  endOfYear,
} from "date-fns";
import { generateReportPdf } from "@/lib/reports/pdf";
import type { ReportPdfData } from "@/lib/reports/pdf-template";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

/**
 * Compute date range from query params.
 * If both `from` and `to` are provided, use them directly.
 * Otherwise fall back to the `period` preset.
 */
function getDateRange(params: URLSearchParams): { from: string; to: string } {
  const fromParam = params.get("from");
  const toParam = params.get("to");
  if (fromParam && toParam) return { from: fromParam, to: toParam };

  const period = params.get("period") || "month";
  const now = new Date();

  switch (period) {
    case "week":
      return {
        from: format(startOfWeek(now, { weekStartsOn: 1 }), "yyyy-MM-dd"),
        to: format(endOfWeek(now, { weekStartsOn: 1 }), "yyyy-MM-dd"),
      };
    case "quarter":
      return {
        from: format(startOfQuarter(now), "yyyy-MM-dd"),
        to: format(endOfQuarter(now), "yyyy-MM-dd"),
      };
    case "year":
      return {
        from: format(startOfYear(now), "yyyy-MM-dd"),
        to: format(endOfYear(now), "yyyy-MM-dd"),
      };
    case "month":
    default:
      return {
        from: format(startOfMonth(now), "yyyy-MM-dd"),
        to: format(endOfMonth(now), "yyyy-MM-dd"),
      };
  }
}

function escapeCell(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// GET /api/v1/organizations/[orgId]/reports/export?format=csv&tab=overview&from=&to=&period=&clientId=&projectId=
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const formatParam = searchParams.get("format") || "csv";
    const tab = searchParams.get("tab") || "overview";
    const clientId = searchParams.get("clientId");
    const projectId = searchParams.get("projectId");
    const { from, to } = getDateRange(searchParams);

    if (tab === "overview") {
      const overviewData = await fetchOverviewData(orgId, from, to, clientId, projectId, organization);

      if (formatParam === "pdf") {
        const pdfData: ReportPdfData = {
          organizationName: organization.name,
          reportTitle: "Overview Report",
          dateRange: `${from} - ${to}`,
          generatedAt: new Date().toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          financial: {
            revenue: overviewData.totalRevenue,
            expenses: overviewData.totalExpenses,
            profit: overviewData.totalRevenue - overviewData.totalExpenses,
            outstanding: 0,
          },
          timeByClient: overviewData.clientRows.map((row) => ({
            name: row.name,
            billableHours: row.billableMinutes / 60,
            unbillableHours: row.unbillableMinutes / 60,
            amount: row.amountCents,
          })),
          expensesByCategory: overviewData.expensesByCategory.map((row) => ({
            category: row.category,
            amount: Number(row.totalCents),
          })),
        };

        const pdfBuffer = await generateReportPdf(pdfData);
        return new NextResponse(Buffer.from(pdfBuffer), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="report-${tab}-${from}-to-${to}.pdf"`,
          },
        });
      }

      // CSV
      const csvSections: string[] = [];
      buildOverviewCsv(csvSections, overviewData);
      const csvContent = csvSections.join("\n");
      const filename = `report-${tab}-${from}-to-${to}.csv`;

      return new NextResponse(csvContent, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    } else if (tab === "accounting") {
      const accountingData = await fetchAccountingData(orgId, from, to, clientId, projectId);

      if (formatParam === "pdf") {
        const pdfData: ReportPdfData = {
          organizationName: organization.name,
          reportTitle: "Accounting Report",
          dateRange: `${from} - ${to}`,
          generatedAt: new Date().toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          accountingMonths: accountingData.sortedMonths.map(([month, data]) => ({
            month,
            income: data.income,
            expenses: data.expenses,
            profit: data.income - data.expenses,
          })),
        };

        const pdfBuffer = await generateReportPdf(pdfData);
        return new NextResponse(Buffer.from(pdfBuffer), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="report-${tab}-${from}-to-${to}.pdf"`,
          },
        });
      }

      // CSV
      const csvSections: string[] = [];
      buildAccountingCsv(csvSections, accountingData);
      const csvContent = csvSections.join("\n");
      const filename = `report-${tab}-${from}-to-${to}.csv`;

      return new NextResponse(csvContent, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    // Unknown tab
    return NextResponse.json({ error: "Invalid tab" }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error exporting report:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Data types for shared fetching
// ---------------------------------------------------------------------------

type OverviewData = {
  totalRevenue: number;
  totalExpenses: number;
  totalBillableMinutes: number;
  totalUnbillableMinutes: number;
  totalMinutes: number;
  clientRows: Array<{
    name: string;
    billableMinutes: number;
    unbillableMinutes: number;
    amountCents: number;
  }>;
  expensesByCategory: Array<{
    category: string;
    totalCents: number;
  }>;
};

type AccountingData = {
  sortedMonths: Array<[string, { income: number; expenses: number }]>;
};

// ---------------------------------------------------------------------------
// Overview tab: fetch data
// ---------------------------------------------------------------------------

async function fetchOverviewData(
  orgId: string,
  from: string,
  to: string,
  clientId: string | null,
  projectId: string | null,
  organization: { defaultRate: number | null }
): Promise<OverviewData> {
  // Fetch time entries with rate/billability info (mirrors analytics route)
  const entriesWithRelations = await db
    .select({
      durationMinutes: timeEntries.durationMinutes,
      clientId: timeEntries.clientId,
      clientName: clients.name,
      isBillableOverride: timeEntries.isBillableOverride,
      clientIsBillable: clients.isBillable,
      projectIsBillable: projects.isBillable,
      taskIsBillable: tasks.isBillable,
      clientRate: clients.rateOverride,
      projectRate: projects.rateOverride,
      taskRate: tasks.rateOverride,
    })
    .from(timeEntries)
    .innerJoin(clients, eq(timeEntries.clientId, clients.id))
    .leftJoin(projects, eq(timeEntries.projectId, projects.id))
    .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
    .where(
      and(
        eq(timeEntries.organizationId, orgId),
        gte(timeEntries.date, from),
        lte(timeEntries.date, to),
        ...(clientId ? [eq(timeEntries.clientId, clientId)] : []),
        ...(projectId ? [eq(timeEntries.projectId, projectId)] : [])
      )
    );

  const getIsBillable = (entry: (typeof entriesWithRelations)[0]): boolean => {
    if (entry.isBillableOverride !== null) return entry.isBillableOverride;
    if (entry.taskIsBillable !== null) return entry.taskIsBillable;
    if (entry.projectIsBillable !== null) return entry.projectIsBillable;
    if (entry.clientIsBillable !== null) return entry.clientIsBillable;
    return true;
  };

  const getRate = (entry: (typeof entriesWithRelations)[0]): number => {
    return (
      entry.taskRate ??
      entry.projectRate ??
      entry.clientRate ??
      organization.defaultRate ??
      0
    );
  };

  // Aggregate by client
  const clientMap = new Map<
    string,
    { name: string; billableMinutes: number; unbillableMinutes: number; amountCents: number }
  >();

  for (const entry of entriesWithRelations) {
    const isBillable = getIsBillable(entry);
    const rate = getRate(entry);
    const amount = isBillable ? Math.round((entry.durationMinutes / 60) * rate) : 0;

    const existing = clientMap.get(entry.clientId);
    if (existing) {
      existing.amountCents += amount;
      if (isBillable) {
        existing.billableMinutes += entry.durationMinutes;
      } else {
        existing.unbillableMinutes += entry.durationMinutes;
      }
    } else {
      clientMap.set(entry.clientId, {
        name: entry.clientName,
        billableMinutes: isBillable ? entry.durationMinutes : 0,
        unbillableMinutes: isBillable ? 0 : entry.durationMinutes,
        amountCents: amount,
      });
    }
  }

  // Totals from time data
  let totalRevenue = 0;
  let totalBillableMinutes = 0;
  let totalUnbillableMinutes = 0;
  for (const data of clientMap.values()) {
    totalRevenue += data.amountCents;
    totalBillableMinutes += data.billableMinutes;
    totalUnbillableMinutes += data.unbillableMinutes;
  }
  const totalMinutes = totalBillableMinutes + totalUnbillableMinutes;

  // Fetch expenses, joining through projects when filtering by clientId
  const expenseConditions = [
    eq(projectExpenses.organizationId, orgId),
    gte(projectExpenses.date, from),
    lte(projectExpenses.date, to),
  ];
  if (clientId) {
    const clientProjectIds = db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.clientId, clientId));
    expenseConditions.push(inArray(projectExpenses.projectId, clientProjectIds));
  }
  if (projectId) {
    expenseConditions.push(eq(projectExpenses.projectId, projectId));
  }

  const expensesByCategory = await db
    .select({
      category: sql<string>`COALESCE(${projectExpenses.category}, 'Uncategorized')`,
      totalCents: sql<number>`COALESCE(SUM(${projectExpenses.amountCents}), 0)`,
    })
    .from(projectExpenses)
    .where(and(...expenseConditions))
    .groupBy(sql`COALESCE(${projectExpenses.category}, 'Uncategorized')`)
    .orderBy(sql`SUM(${projectExpenses.amountCents}) DESC`);

  const totalExpenses = expensesByCategory.reduce(
    (sum, row) => sum + Number(row.totalCents),
    0
  );

  // Sort clients by total time descending
  const clientRows = [...clientMap.values()].sort(
    (a, b) => b.billableMinutes + b.unbillableMinutes - (a.billableMinutes + a.unbillableMinutes)
  );

  return {
    totalRevenue,
    totalExpenses,
    totalBillableMinutes,
    totalUnbillableMinutes,
    totalMinutes,
    clientRows,
    expensesByCategory: expensesByCategory.map((row) => ({
      category: row.category,
      totalCents: Number(row.totalCents),
    })),
  };
}

// ---------------------------------------------------------------------------
// Overview tab: build CSV from fetched data
// ---------------------------------------------------------------------------

function buildOverviewCsv(csvSections: string[], data: OverviewData) {
  csvSections.push("FINANCIAL SUMMARY");
  csvSections.push("Metric,Value");
  csvSections.push(`Billable Revenue,${formatCurrency(data.totalRevenue)}`);
  csvSections.push(`Expenses,${formatCurrency(data.totalExpenses)}`);
  csvSections.push(`Profit,${formatCurrency(data.totalRevenue - data.totalExpenses)}`);
  csvSections.push(`Total Hours,${(data.totalMinutes / 60).toFixed(1)}`);
  csvSections.push(`Billable Hours,${(data.totalBillableMinutes / 60).toFixed(1)}`);
  csvSections.push(`Unbillable Hours,${(data.totalUnbillableMinutes / 60).toFixed(1)}`);
  csvSections.push("");

  csvSections.push("TIME BY CLIENT");
  csvSections.push("Client,Billable Hours,Unbillable Hours,Total Hours,Amount");
  for (const row of data.clientRows) {
    const billable = row.billableMinutes / 60;
    const unbillable = row.unbillableMinutes / 60;
    const total = billable + unbillable;
    csvSections.push(
      `${escapeCell(row.name)},${billable.toFixed(1)},${unbillable.toFixed(1)},${total.toFixed(1)},${formatCurrency(row.amountCents)}`
    );
  }
  csvSections.push("");

  if (data.expensesByCategory.length > 0) {
    csvSections.push("EXPENSES BY CATEGORY");
    csvSections.push("Category,Amount");
    for (const row of data.expensesByCategory) {
      csvSections.push(
        `${escapeCell(row.category)},${formatCurrency(row.totalCents)}`
      );
    }
    csvSections.push("");
  }
}

// ---------------------------------------------------------------------------
// Accounting tab: fetch data
// ---------------------------------------------------------------------------

async function fetchAccountingData(
  orgId: string,
  from: string,
  to: string,
  clientId: string | null,
  projectId: string | null
): Promise<AccountingData> {
  // Paid invoices by month
  const paidInvoicesByMonth = await db
    .select({
      month: sql<string>`to_char(${invoices.periodEnd}::date, 'YYYY-MM')`,
      total: sql<number>`COALESCE(SUM(${invoices.subtotal}), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, orgId),
        sql`${invoices.status} = 'paid'`,
        gte(invoices.periodEnd, from),
        lte(invoices.periodEnd, to),
        ...(clientId ? [eq(invoices.clientId, clientId)] : [])
      )
    )
    .groupBy(sql`to_char(${invoices.periodEnd}::date, 'YYYY-MM')`)
    .orderBy(sql`to_char(${invoices.periodEnd}::date, 'YYYY-MM')`);

  // Expenses by month, joining through projects when filtering by clientId
  const expenseQuery = db
    .select({
      month: sql<string>`to_char(${projectExpenses.date}::date, 'YYYY-MM')`,
      total: sql<number>`COALESCE(SUM(${projectExpenses.amountCents}), 0)`,
    })
    .from(projectExpenses);

  const expenseWithJoin = clientId
    ? expenseQuery.innerJoin(projects, eq(projectExpenses.projectId, projects.id))
    : expenseQuery;

  const expensesByMonth = await expenseWithJoin
    .where(
      and(
        eq(projectExpenses.organizationId, orgId),
        gte(projectExpenses.date, from),
        lte(projectExpenses.date, to),
        ...(clientId ? [eq(projects.clientId, clientId)] : []),
        ...(projectId ? [eq(projectExpenses.projectId, projectId)] : [])
      )
    )
    .groupBy(sql`to_char(${projectExpenses.date}::date, 'YYYY-MM')`)
    .orderBy(sql`to_char(${projectExpenses.date}::date, 'YYYY-MM')`);

  // Merge into monthly rows
  const months = new Map<string, { income: number; expenses: number }>();

  for (const row of paidInvoicesByMonth) {
    months.set(row.month, { income: Number(row.total), expenses: 0 });
  }
  for (const row of expensesByMonth) {
    const existing = months.get(row.month) || { income: 0, expenses: 0 };
    existing.expenses = Number(row.total);
    months.set(row.month, existing);
  }

  const sortedMonths = [...months.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return { sortedMonths };
}

// ---------------------------------------------------------------------------
// Accounting tab: build CSV from fetched data
// ---------------------------------------------------------------------------

function buildAccountingCsv(csvSections: string[], data: AccountingData) {
  csvSections.push("ACCOUNTING BY MONTH");
  csvSections.push("Month,Income,Expenses,Profit");

  for (const [month, row] of data.sortedMonths) {
    const profit = row.income - row.expenses;
    csvSections.push(
      `${month},${formatCurrency(row.income)},${formatCurrency(row.expenses)},${formatCurrency(profit)}`
    );
  }
}
