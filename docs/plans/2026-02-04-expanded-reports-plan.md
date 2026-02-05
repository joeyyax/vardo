# Expanded Reports Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the reports page into a comprehensive dashboard showing financial summary, time breakdown, invoice status, expense breakdown, and project health - adaptive to enabled feature flags.

**Architecture:** Refactor the reports page from tabbed layout to sectioned scrollable dashboard. Add three new API endpoints for invoice/expense/project reports. Each section is an independent component that fetches its own data and respects feature flags.

**Tech Stack:** Next.js App Router, React, Tailwind CSS, shadcn/ui Card components, Drizzle ORM, date-fns

---

## Task 1: Add Custom Date Range Support to Analytics API

**Files:**
- Modify: `app/api/v1/organizations/[orgId]/analytics/route.ts`

**Step 1: Add from/to query param handling**

In `app/api/v1/organizations/[orgId]/analytics/route.ts`, update the date calculation logic to support custom ranges:

```typescript
const url = new URL(request.url);
const period = url.searchParams.get("period");
const fromParam = url.searchParams.get("from");
const toParam = url.searchParams.get("to");

// Calculate date range based on period or custom range
const now = new Date();
let fromDate: Date;
let toDate: Date = now;

if (fromParam && toParam) {
  // Custom date range
  fromDate = new Date(fromParam);
  toDate = new Date(toParam);
} else {
  // Preset periods
  switch (period || "month") {
    case "week":
      fromDate = startOfWeek(now, { weekStartsOn: 1 });
      break;
    case "month":
      fromDate = startOfMonth(now);
      break;
    case "quarter":
      fromDate = startOfQuarter(now);
      break;
    case "year":
      fromDate = startOfYear(now);
      break;
    default:
      fromDate = startOfMonth(now);
  }
}

const fromDateStr = format(fromDate, "yyyy-MM-dd");
const toDateStr = format(toDate, "yyyy-MM-dd");
```

**Step 2: Update query to use date range**

Update the where clause to filter by both from and to dates:

```typescript
.where(
  and(
    eq(timeEntries.organizationId, orgId),
    gte(timeEntries.date, fromDateStr),
    lte(timeEntries.date, toDateStr)
  )
)
```

Add import for `lte` from drizzle-orm.

**Step 3: Add top projects to response**

Add project breakdown to the analytics response:

```typescript
// Group by project
const projectMap = new Map<
  string,
  {
    name: string;
    clientName: string;
    totalMinutes: number;
    totalAmount: number;
  }
>();

for (const entry of entriesWithRelations) {
  if (!entry.projectId || !entry.projectName) continue;
  const existing = projectMap.get(entry.projectId);
  const isBillable = getIsBillable(entry);
  const rate = getRate(entry);
  const amount = isBillable
    ? Math.round((entry.durationMinutes / 60) * rate)
    : 0;

  if (existing) {
    existing.totalMinutes += entry.durationMinutes;
    existing.totalAmount += amount;
  } else {
    projectMap.set(entry.projectId, {
      name: entry.projectName,
      clientName: entry.clientName,
      totalMinutes: entry.durationMinutes,
      totalAmount: amount,
    });
  }
}

const topProjects = Array.from(projectMap.entries())
  .map(([id, data]) => ({ id, ...data }))
  .sort((a, b) => b.totalMinutes - a.totalMinutes)
  .slice(0, 5);
```

Update the select to include project info:

```typescript
projectId: timeEntries.projectId,
projectName: projects.name,
```

Add `topProjects` to the response JSON.

**Step 4: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/analytics/route.ts
git commit -m "feat(reports): add custom date range and top projects to analytics API"
```

---

## Task 2: Create Invoice Reports API Endpoint

**Files:**
- Create: `app/api/v1/organizations/[orgId]/reports/invoices/route.ts`

**Step 1: Create the endpoint**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { format, subDays } from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    const now = new Date();
    const fromDate = fromParam ? new Date(fromParam) : new Date(now.getFullYear(), now.getMonth(), 1);
    const toDate = toParam ? new Date(toParam) : now;

    // Get all invoices for the org
    const allInvoices = await db.query.invoices.findMany({
      where: eq(invoices.organizationId, orgId),
      columns: {
        id: true,
        invoiceNumber: true,
        status: true,
        subtotal: true,
        dueDate: true,
        sentAt: true,
        viewedAt: true,
        createdAt: true,
      },
      with: {
        client: {
          columns: { id: true, name: true },
        },
      },
    });

    // Calculate totals by status
    const paid = allInvoices
      .filter((inv) => inv.status === "paid")
      .reduce((sum, inv) => sum + (inv.subtotal || 0), 0);
    const pending = allInvoices
      .filter((inv) => inv.status === "sent" && (!inv.dueDate || new Date(inv.dueDate) >= now))
      .reduce((sum, inv) => sum + (inv.subtotal || 0), 0);
    const overdue = allInvoices
      .filter((inv) => inv.status === "sent" && inv.dueDate && new Date(inv.dueDate) < now)
      .reduce((sum, inv) => sum + (inv.subtotal || 0), 0);
    const draft = allInvoices
      .filter((inv) => inv.status === "draft")
      .reduce((sum, inv) => sum + (inv.subtotal || 0), 0);

    // Aging breakdown for outstanding invoices
    const outstanding = allInvoices.filter((inv) => inv.status === "sent");
    const aging = {
      current: 0,
      days1to30: 0,
      days31to60: 0,
      days60plus: 0,
    };

    for (const inv of outstanding) {
      if (!inv.dueDate) {
        aging.current += inv.subtotal || 0;
        continue;
      }
      const dueDate = new Date(inv.dueDate);
      const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

      if (daysOverdue <= 0) {
        aging.current += inv.subtotal || 0;
      } else if (daysOverdue <= 30) {
        aging.days1to30 += inv.subtotal || 0;
      } else if (daysOverdue <= 60) {
        aging.days31to60 += inv.subtotal || 0;
      } else {
        aging.days60plus += inv.subtotal || 0;
      }
    }

    // Recent activity (last 10 events)
    const recentActivity = allInvoices
      .flatMap((inv) => {
        const events: Array<{
          invoiceId: string;
          invoiceNumber: string;
          clientName: string;
          event: "paid" | "sent" | "viewed";
          amount: number;
          date: string;
        }> = [];

        if (inv.status === "paid") {
          events.push({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            clientName: inv.client?.name || "Unknown",
            event: "paid",
            amount: inv.subtotal || 0,
            date: inv.createdAt.toISOString(),
          });
        }
        if (inv.sentAt) {
          events.push({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            clientName: inv.client?.name || "Unknown",
            event: "sent",
            amount: inv.subtotal || 0,
            date: inv.sentAt.toISOString(),
          });
        }
        if (inv.viewedAt) {
          events.push({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            clientName: inv.client?.name || "Unknown",
            event: "viewed",
            amount: inv.subtotal || 0,
            date: inv.viewedAt.toISOString(),
          });
        }

        return events;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 10);

    return NextResponse.json({
      paid,
      pending,
      overdue,
      draft,
      aging,
      recentActivity,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching invoice report:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/reports/invoices/route.ts
git commit -m "feat(reports): add invoice reports API endpoint"
```

---

## Task 3: Create Expense Reports API Endpoint

**Files:**
- Create: `app/api/v1/organizations/[orgId]/reports/expenses/route.ts`

**Step 1: Create the endpoint**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExpenses, projects, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { format } from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    // Build date filter
    const conditions = [eq(projectExpenses.organizationId, orgId)];
    if (fromParam) {
      conditions.push(gte(projectExpenses.date, fromParam));
    }
    if (toParam) {
      conditions.push(lte(projectExpenses.date, toParam));
    }

    // Get all expenses with project info
    const expenses = await db.query.projectExpenses.findMany({
      where: and(...conditions),
      with: {
        project: {
          columns: { id: true, name: true },
          with: {
            client: {
              columns: { id: true, name: true },
            },
          },
        },
      },
    });

    // Calculate totals
    const totalCents = expenses.reduce((sum, e) => sum + e.amountCents, 0);
    const billableCents = expenses
      .filter((e) => e.isBillable)
      .reduce((sum, e) => sum + e.amountCents, 0);
    const nonBillableCents = totalCents - billableCents;

    // Group by category
    const categoryMap = new Map<string, number>();
    for (const expense of expenses) {
      const cat = expense.category || "Uncategorized";
      categoryMap.set(cat, (categoryMap.get(cat) || 0) + expense.amountCents);
    }
    const byCategory = Array.from(categoryMap.entries())
      .map(([category, amountCents]) => ({ category, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents);

    // Group by project
    const projectMap = new Map<string, { name: string; clientName: string; amountCents: number }>();
    for (const expense of expenses) {
      if (!expense.project) continue;
      const key = expense.project.id;
      const existing = projectMap.get(key);
      if (existing) {
        existing.amountCents += expense.amountCents;
      } else {
        projectMap.set(key, {
          name: expense.project.name,
          clientName: expense.project.client?.name || "Unknown",
          amountCents: expense.amountCents,
        });
      }
    }
    const byProject = Array.from(projectMap.entries())
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 5);

    // Recovery rate
    const recoveryRate = totalCents > 0 ? (billableCents / totalCents) * 100 : 0;

    return NextResponse.json({
      totalCents,
      billableCents,
      nonBillableCents,
      byCategory,
      byProject,
      recoveryRate,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching expense report:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/reports/expenses/route.ts
git commit -m "feat(reports): add expense reports API endpoint"
```

---

## Task 4: Create Project Health API Endpoint

**Files:**
- Create: `app/api/v1/organizations/[orgId]/reports/projects/route.ts`

**Step 1: Create the endpoint**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, clients, timeEntries } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, sql, inArray } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

type BudgetStatus = "on_budget" | "at_risk" | "over_budget" | "no_budget";

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get all clients for this org
    const orgClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
      columns: { id: true },
    });
    const orgClientIds = orgClients.map((c) => c.id);

    if (orgClientIds.length === 0) {
      return NextResponse.json({
        activeCount: 0,
        onBudgetCount: 0,
        atRiskCount: 0,
        overBudgetCount: 0,
        projectsWithBudgets: [],
        projectsWithoutBudgets: [],
      });
    }

    // Get all active projects
    const activeProjects = await db.query.projects.findMany({
      where: and(
        inArray(projects.clientId, orgClientIds),
        eq(projects.isArchived, false)
      ),
      with: {
        client: {
          columns: { id: true, name: true, color: true },
        },
      },
    });

    // Get time totals per project
    const projectIds = activeProjects.map((p) => p.id);
    const timeByProject = new Map<string, number>();

    if (projectIds.length > 0) {
      const timeTotals = await db
        .select({
          projectId: timeEntries.projectId,
          totalMinutes: sql<number>`sum(${timeEntries.durationMinutes})`.as("total_minutes"),
        })
        .from(timeEntries)
        .where(inArray(timeEntries.projectId, projectIds))
        .groupBy(timeEntries.projectId);

      for (const row of timeTotals) {
        if (row.projectId) {
          timeByProject.set(row.projectId, Number(row.totalMinutes) || 0);
        }
      }
    }

    // Calculate budget status for each project
    const projectsWithBudgets: Array<{
      id: string;
      name: string;
      clientName: string;
      clientColor: string | null;
      budgetType: string;
      budgetValue: number;
      usedValue: number;
      usedPercentage: number;
      status: BudgetStatus;
    }> = [];

    const projectsWithoutBudgets: Array<{
      id: string;
      name: string;
      clientName: string;
      clientColor: string | null;
      totalMinutes: number;
    }> = [];

    for (const project of activeProjects) {
      const totalMinutes = timeByProject.get(project.id) || 0;

      if (project.budgetType && (project.budgetHours || project.budgetAmountCents)) {
        let budgetValue: number;
        let usedValue: number;

        if (project.budgetType === "hours") {
          budgetValue = project.budgetHours || 0;
          usedValue = Math.round(totalMinutes / 60);
        } else {
          // fixed budget - would need expense data too, but for now just use time value
          budgetValue = project.budgetAmountCents || 0;
          usedValue = Math.round((totalMinutes / 60) * (organization.defaultRate || 0));
        }

        const usedPercentage = budgetValue > 0 ? (usedValue / budgetValue) * 100 : 0;

        let status: BudgetStatus;
        if (usedPercentage > 100) {
          status = "over_budget";
        } else if (usedPercentage >= 80) {
          status = "at_risk";
        } else {
          status = "on_budget";
        }

        projectsWithBudgets.push({
          id: project.id,
          name: project.name,
          clientName: project.client.name,
          clientColor: project.client.color,
          budgetType: project.budgetType,
          budgetValue,
          usedValue,
          usedPercentage,
          status,
        });
      } else {
        projectsWithoutBudgets.push({
          id: project.id,
          name: project.name,
          clientName: project.client.name,
          clientColor: project.client.color,
          totalMinutes,
        });
      }
    }

    // Sort by risk (over budget first, then at risk, then on budget)
    projectsWithBudgets.sort((a, b) => {
      const statusOrder = { over_budget: 0, at_risk: 1, on_budget: 2, no_budget: 3 };
      return statusOrder[a.status] - statusOrder[b.status];
    });

    // Calculate counts
    const onBudgetCount = projectsWithBudgets.filter((p) => p.status === "on_budget").length;
    const atRiskCount = projectsWithBudgets.filter((p) => p.status === "at_risk").length;
    const overBudgetCount = projectsWithBudgets.filter((p) => p.status === "over_budget").length;

    return NextResponse.json({
      activeCount: activeProjects.length,
      onBudgetCount,
      atRiskCount,
      overBudgetCount,
      projectsWithBudgets,
      projectsWithoutBudgets,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching project report:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add app/api/v1/organizations/\[orgId\]/reports/projects/route.ts
git commit -m "feat(reports): add project health API endpoint"
```

---

## Task 5: Create Date Range Picker Component

**Files:**
- Create: `components/reports/date-range-picker.tsx`

**Step 1: Create the component**

```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { DateRange } from "react-day-picker";

export type Period = "week" | "month" | "quarter" | "year" | "custom";

type DateRangePickerProps = {
  period: Period;
  customRange: DateRange | undefined;
  onPeriodChange: (period: Period) => void;
  onCustomRangeChange: (range: DateRange | undefined) => void;
};

export function DateRangePicker({
  period,
  customRange,
  onPeriodChange,
  onCustomRangeChange,
}: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handlePeriodChange = (value: string) => {
    if (value === "custom") {
      setIsOpen(true);
    }
    onPeriodChange(value as Period);
  };

  return (
    <div className="flex items-center gap-2">
      <Select value={period} onValueChange={handlePeriodChange}>
        <SelectTrigger className="squircle w-[180px]">
          <SelectValue placeholder="Select period" />
        </SelectTrigger>
        <SelectContent className="squircle">
          <SelectItem value="week">This Week</SelectItem>
          <SelectItem value="month">This Month</SelectItem>
          <SelectItem value="quarter">This Quarter</SelectItem>
          <SelectItem value="year">This Year</SelectItem>
          <SelectItem value="custom">Custom Range</SelectItem>
        </SelectContent>
      </Select>

      {period === "custom" && (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="squircle gap-2">
              <CalendarIcon className="size-4" />
              {customRange?.from ? (
                customRange.to ? (
                  <>
                    {format(customRange.from, "MMM d")} -{" "}
                    {format(customRange.to, "MMM d, yyyy")}
                  </>
                ) : (
                  format(customRange.from, "MMM d, yyyy")
                )
              ) : (
                "Pick dates"
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="squircle w-auto p-0" align="start">
            <Calendar
              initialFocus
              mode="range"
              defaultMonth={customRange?.from}
              selected={customRange}
              onSelect={onCustomRangeChange}
              numberOfMonths={2}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add components/reports/date-range-picker.tsx
git commit -m "feat(reports): add date range picker component"
```

---

## Task 6: Create Report Section Components

**Files:**
- Create: `components/reports/financial-summary.tsx`
- Create: `components/reports/time-breakdown.tsx`
- Create: `components/reports/invoice-status.tsx`
- Create: `components/reports/expense-breakdown.tsx`
- Create: `components/reports/project-health.tsx`

**Step 1: Create financial-summary.tsx**

```typescript
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, TrendingUp, TrendingDown, Receipt, AlertCircle } from "lucide-react";
import { OrgFeatures } from "@/lib/db/schema";

type FinancialSummaryProps = {
  revenue: number;
  revenueSource: "invoices" | "billable_time";
  expenses?: number;
  outstanding?: number;
  features: OrgFeatures;
  isLoading?: boolean;
};

export function FinancialSummary({
  revenue,
  revenueSource,
  expenses,
  outstanding,
  features,
  isLoading,
}: FinancialSummaryProps) {
  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  const margin = expenses !== undefined ? revenue - expenses : undefined;
  const marginPercent = margin !== undefined && revenue > 0
    ? ((margin / revenue) * 100).toFixed(0)
    : undefined;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Financial Summary</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Revenue</CardTitle>
            <DollarSign className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(revenue)}</div>
            <p className="text-xs text-muted-foreground">
              {revenueSource === "invoices" ? "From invoices" : "Billable time"}
            </p>
          </CardContent>
        </Card>

        {features.expenses && expenses !== undefined && (
          <Card className="squircle">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Expenses</CardTitle>
              <Receipt className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(expenses)}</div>
              <p className="text-xs text-muted-foreground">Total costs</p>
            </CardContent>
          </Card>
        )}

        {features.expenses && margin !== undefined && (
          <Card className="squircle">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Margin</CardTitle>
              {margin >= 0 ? (
                <TrendingUp className="size-4 text-green-500" />
              ) : (
                <TrendingDown className="size-4 text-red-500" />
              )}
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${margin >= 0 ? "text-green-600" : "text-red-600"}`}>
                {formatCurrency(margin)}
              </div>
              <p className="text-xs text-muted-foreground">
                {marginPercent}% margin
              </p>
            </CardContent>
          </Card>
        )}

        {features.invoicing && outstanding !== undefined && (
          <Card className="squircle">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Outstanding</CardTitle>
              <AlertCircle className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(outstanding)}</div>
              <p className="text-xs text-muted-foreground">Unpaid invoices</p>
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}
```

**Step 2: Create time-breakdown.tsx**

```typescript
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock, DollarSign, ClockArrowDown, Percent } from "lucide-react";

type ClientData = {
  id: string;
  name: string;
  color: string | null;
  totalMinutes: number;
  billableMinutes: number;
  unbillableMinutes: number;
  totalAmount: number;
};

type ProjectData = {
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
  clientBreakdown: ClientData[];
  topProjects?: ProjectData[];
};

export function TimeBreakdown({
  totalMinutes,
  totalBillable,
  totalUnbillableMinutes,
  clientBreakdown,
  topProjects,
}: TimeBreakdownProps) {
  const formatHours = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  const billableMinutes = totalMinutes - totalUnbillableMinutes;
  const utilization = totalMinutes > 0 ? (billableMinutes / totalMinutes) * 100 : 0;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Time Breakdown</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Time</CardTitle>
            <Clock className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatHours(totalMinutes)}</div>
            <p className="text-xs text-muted-foreground">
              {(totalMinutes / 60).toFixed(1)} hours
            </p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Billable Amount</CardTitle>
            <DollarSign className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalBillable)}</div>
            <p className="text-xs text-muted-foreground">
              {formatHours(billableMinutes)} billable
            </p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unbillable</CardTitle>
            <ClockArrowDown className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatHours(totalUnbillableMinutes)}</div>
            <p className="text-xs text-muted-foreground">
              {totalMinutes > 0
                ? ((totalUnbillableMinutes / totalMinutes) * 100).toFixed(0)
                : 0}% of total
            </p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Utilization</CardTitle>
            <Percent className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{utilization.toFixed(0)}%</div>
            <p className="text-xs text-muted-foreground">Billable ratio</p>
          </CardContent>
        </Card>
      </div>

      {/* Client breakdown */}
      {clientBreakdown.length > 0 && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Hours by Client</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {clientBreakdown.map((client) => {
                const percentage = totalMinutes > 0
                  ? (client.totalMinutes / totalMinutes) * 100
                  : 0;
                const billablePercentage = client.totalMinutes > 0
                  ? (client.billableMinutes / client.totalMinutes) * 100
                  : 0;
                return (
                  <div key={client.id} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div
                          className="size-3 rounded-full"
                          style={{ backgroundColor: client.color || "#94a3b8" }}
                        />
                        <span className="font-medium">{client.name}</span>
                      </div>
                      <div className="flex items-center gap-4 text-muted-foreground">
                        <span>{formatHours(client.totalMinutes)}</span>
                        {client.unbillableMinutes > 0 && (
                          <span className="text-xs">
                            ({formatHours(client.unbillableMinutes)} unbillable)
                          </span>
                        )}
                        <span className="w-12 text-right">{percentage.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden flex">
                      <div
                        className="h-full transition-all"
                        style={{
                          width: `${(billablePercentage / 100) * percentage}%`,
                          backgroundColor: client.color || "#94a3b8",
                        }}
                      />
                      {client.unbillableMinutes > 0 && (
                        <div
                          className="h-full transition-all opacity-40"
                          style={{
                            width: `${((100 - billablePercentage) / 100) * percentage}%`,
                            backgroundColor: client.color || "#94a3b8",
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top projects */}
      {topProjects && topProjects.length > 0 && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Top Projects</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topProjects.map((project) => (
                <div key={project.id} className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{project.name}</div>
                    <div className="text-xs text-muted-foreground">{project.clientName}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium">{formatHours(project.totalMinutes)}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatCurrency(project.totalAmount)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
```

**Step 3: Create invoice-status.tsx**

```typescript
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, Clock, AlertTriangle, FileText } from "lucide-react";

type AgingData = {
  current: number;
  days1to30: number;
  days31to60: number;
  days60plus: number;
};

type ActivityEvent = {
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
  aging: AgingData;
  recentActivity: ActivityEvent[];
};

export function InvoiceStatus({
  paid,
  pending,
  overdue,
  draft,
  aging,
  recentActivity,
}: InvoiceStatusProps) {
  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const totalOutstanding = aging.current + aging.days1to30 + aging.days31to60 + aging.days60plus;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Invoice Status</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Paid</CardTitle>
            <CheckCircle className="size-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{formatCurrency(paid)}</div>
            <p className="text-xs text-muted-foreground">Collected</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
            <Clock className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(pending)}</div>
            <p className="text-xs text-muted-foreground">Not yet due</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Overdue</CardTitle>
            <AlertTriangle className="size-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{formatCurrency(overdue)}</div>
            <p className="text-xs text-muted-foreground">Past due date</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Draft</CardTitle>
            <FileText className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(draft)}</div>
            <p className="text-xs text-muted-foreground">Not sent</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Aging breakdown */}
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Aging Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                { label: "Current", value: aging.current, color: "bg-green-500" },
                { label: "1-30 days", value: aging.days1to30, color: "bg-yellow-500" },
                { label: "31-60 days", value: aging.days31to60, color: "bg-orange-500" },
                { label: "60+ days", value: aging.days60plus, color: "bg-red-500" },
              ].map((item) => (
                <div key={item.label} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>{item.label}</span>
                    <span className="font-medium">{formatCurrency(item.value)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full ${item.color} transition-all`}
                      style={{
                        width: totalOutstanding > 0
                          ? `${(item.value / totalOutstanding) * 100}%`
                          : "0%",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent activity */}
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity</p>
            ) : (
              <div className="space-y-3">
                {recentActivity.slice(0, 5).map((activity, i) => (
                  <div key={`${activity.invoiceId}-${activity.event}-${i}`} className="flex items-center justify-between text-sm">
                    <div>
                      <span className="font-medium">#{activity.invoiceNumber}</span>
                      <span className="text-muted-foreground"> {activity.event}</span>
                    </div>
                    <div className="text-right text-muted-foreground">
                      <div>{formatCurrency(activity.amount)}</div>
                      <div className="text-xs">{formatDate(activity.date)}</div>
                    </div>
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
```

**Step 4: Create expense-breakdown.tsx**

```typescript
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Receipt, CircleDollarSign, TrendingUp } from "lucide-react";

type CategoryData = {
  category: string;
  amountCents: number;
};

type ProjectData = {
  id: string;
  name: string;
  clientName: string;
  amountCents: number;
};

type ExpenseBreakdownProps = {
  totalCents: number;
  billableCents: number;
  nonBillableCents: number;
  byCategory: CategoryData[];
  byProject: ProjectData[];
  recoveryRate: number;
};

export function ExpenseBreakdown({
  totalCents,
  billableCents,
  nonBillableCents,
  byCategory,
  byProject,
  recoveryRate,
}: ExpenseBreakdownProps) {
  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Expense Breakdown</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Expenses</CardTitle>
            <Receipt className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(totalCents)}</div>
            <p className="text-xs text-muted-foreground">All expenses</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Billable</CardTitle>
            <CircleDollarSign className="size-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{formatCurrency(billableCents)}</div>
            <p className="text-xs text-muted-foreground">Client reimbursable</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Non-billable</CardTitle>
            <Receipt className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(nonBillableCents)}</div>
            <p className="text-xs text-muted-foreground">Internal costs</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Recovery Rate</CardTitle>
            <TrendingUp className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{recoveryRate.toFixed(0)}%</div>
            <p className="text-xs text-muted-foreground">Billed to clients</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* By category */}
        <Card className="squircle">
          <CardHeader>
            <CardTitle>By Category</CardTitle>
          </CardHeader>
          <CardContent>
            {byCategory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No expenses recorded</p>
            ) : (
              <div className="space-y-3">
                {byCategory.slice(0, 6).map((cat) => (
                  <div key={cat.category} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="capitalize">{cat.category}</span>
                      <span className="font-medium">{formatCurrency(cat.amountCents)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{
                          width: totalCents > 0
                            ? `${(cat.amountCents / totalCents) * 100}%`
                            : "0%",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* By project */}
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Top Projects by Expense</CardTitle>
          </CardHeader>
          <CardContent>
            {byProject.length === 0 ? (
              <p className="text-sm text-muted-foreground">No project expenses</p>
            ) : (
              <div className="space-y-3">
                {byProject.map((project) => (
                  <div key={project.id} className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{project.name}</div>
                      <div className="text-xs text-muted-foreground">{project.clientName}</div>
                    </div>
                    <div className="font-medium">{formatCurrency(project.amountCents)}</div>
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
```

**Step 5: Create project-health.tsx**

```typescript
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FolderOpen, CheckCircle, AlertTriangle, XCircle } from "lucide-react";

type ProjectWithBudget = {
  id: string;
  name: string;
  clientName: string;
  clientColor: string | null;
  budgetType: string;
  budgetValue: number;
  usedValue: number;
  usedPercentage: number;
  status: "on_budget" | "at_risk" | "over_budget";
};

type ProjectWithoutBudget = {
  id: string;
  name: string;
  clientName: string;
  clientColor: string | null;
  totalMinutes: number;
};

type ProjectHealthProps = {
  activeCount: number;
  onBudgetCount: number;
  atRiskCount: number;
  overBudgetCount: number;
  projectsWithBudgets: ProjectWithBudget[];
  projectsWithoutBudgets: ProjectWithoutBudget[];
};

export function ProjectHealth({
  activeCount,
  onBudgetCount,
  atRiskCount,
  overBudgetCount,
  projectsWithBudgets,
  projectsWithoutBudgets,
}: ProjectHealthProps) {
  const formatValue = (project: ProjectWithBudget) => {
    if (project.budgetType === "hours") {
      return `${project.usedValue}h / ${project.budgetValue}h`;
    }
    const formatCurrency = (cents: number) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(cents / 100);
    return `${formatCurrency(project.usedValue)} / ${formatCurrency(project.budgetValue)}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "on_budget":
        return "bg-green-500";
      case "at_risk":
        return "bg-yellow-500";
      case "over_budget":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  const formatHours = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  };

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Project Health</h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Projects</CardTitle>
            <FolderOpen className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeCount}</div>
            <p className="text-xs text-muted-foreground">Total active</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">On Budget</CardTitle>
            <CheckCircle className="size-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{onBudgetCount}</div>
            <p className="text-xs text-muted-foreground">Under 80%</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">At Risk</CardTitle>
            <AlertTriangle className="size-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{atRiskCount}</div>
            <p className="text-xs text-muted-foreground">80-100%</p>
          </CardContent>
        </Card>

        <Card className="squircle">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Over Budget</CardTitle>
            <XCircle className="size-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{overBudgetCount}</div>
            <p className="text-xs text-muted-foreground">Exceeding budget</p>
          </CardContent>
        </Card>
      </div>

      {projectsWithBudgets.length > 0 && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Budget Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {projectsWithBudgets.map((project) => (
                <div key={project.id} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div
                        className="size-3 rounded-full"
                        style={{ backgroundColor: project.clientColor || "#94a3b8" }}
                      />
                      <span className="font-medium">{project.name}</span>
                      <span className="text-muted-foreground">({project.clientName})</span>
                    </div>
                    <span className="font-medium">{formatValue(project)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full ${getStatusColor(project.status)} transition-all`}
                      style={{ width: `${Math.min(project.usedPercentage, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {projectsWithoutBudgets.length > 0 && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle>Projects Without Budgets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {projectsWithoutBudgets.slice(0, 5).map((project) => (
                <div key={project.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div
                      className="size-3 rounded-full"
                      style={{ backgroundColor: project.clientColor || "#94a3b8" }}
                    />
                    <span>{project.name}</span>
                    <span className="text-muted-foreground">({project.clientName})</span>
                  </div>
                  <span className="text-muted-foreground">{formatHours(project.totalMinutes)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
```

**Step 6: Commit**

```bash
git add components/reports/
git commit -m "feat(reports): add report section components"
```

---

## Task 7: Refactor Reports Page to Sectioned Dashboard

**Files:**
- Modify: `app/(app)/reports/reports-page-content.tsx`
- Modify: `app/(app)/reports/reports-content.tsx`

**Step 1: Update reports-page-content.tsx**

Replace the entire file with the new dashboard layout:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { DateRange } from "react-day-picker";
import { format, startOfWeek, startOfMonth, startOfQuarter, startOfYear } from "date-fns";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { DateRangePicker, Period } from "@/components/reports/date-range-picker";
import { FinancialSummary } from "@/components/reports/financial-summary";
import { TimeBreakdown } from "@/components/reports/time-breakdown";
import { InvoiceStatus } from "@/components/reports/invoice-status";
import { ExpenseBreakdown } from "@/components/reports/expense-breakdown";
import { ProjectHealth } from "@/components/reports/project-health";
import { ReportConfigs } from "@/components/reports/report-configs";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { OrgFeatures, DEFAULT_ORG_FEATURES } from "@/lib/db/schema";

type ReportsPageContentProps = {
  orgId: string;
  features?: OrgFeatures;
};

export function ReportsPageContent({ orgId, features = DEFAULT_ORG_FEATURES }: ReportsPageContentProps) {
  const [period, setPeriod] = useState<Period>("month");
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [sharedReportsOpen, setSharedReportsOpen] = useState(false);

  // Data states
  const [timeData, setTimeData] = useState<any>(null);
  const [invoiceData, setInvoiceData] = useState<any>(null);
  const [expenseData, setExpenseData] = useState<any>(null);
  const [projectData, setProjectData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  const getDateParams = useCallback(() => {
    if (period === "custom" && customRange?.from && customRange?.to) {
      return `from=${format(customRange.from, "yyyy-MM-dd")}&to=${format(customRange.to, "yyyy-MM-dd")}`;
    }
    return `period=${period}`;
  }, [period, customRange]);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    const dateParams = getDateParams();

    try {
      // Fetch all data in parallel based on enabled features
      const fetches: Promise<any>[] = [];

      // Always fetch time data if time_tracking enabled
      if (features.time_tracking) {
        fetches.push(
          fetch(`/api/v1/organizations/${orgId}/analytics?${dateParams}`).then((r) =>
            r.ok ? r.json() : null
          )
        );
      } else {
        fetches.push(Promise.resolve(null));
      }

      // Fetch invoice data if invoicing enabled
      if (features.invoicing) {
        fetches.push(
          fetch(`/api/v1/organizations/${orgId}/reports/invoices?${dateParams}`).then((r) =>
            r.ok ? r.json() : null
          )
        );
      } else {
        fetches.push(Promise.resolve(null));
      }

      // Fetch expense data if expenses enabled
      if (features.expenses) {
        fetches.push(
          fetch(`/api/v1/organizations/${orgId}/reports/expenses?${dateParams}`).then((r) =>
            r.ok ? r.json() : null
          )
        );
      } else {
        fetches.push(Promise.resolve(null));
      }

      // Fetch project data if pm enabled
      if (features.pm) {
        fetches.push(
          fetch(`/api/v1/organizations/${orgId}/reports/projects`).then((r) =>
            r.ok ? r.json() : null
          )
        );
      } else {
        fetches.push(Promise.resolve(null));
      }

      const [time, invoice, expense, project] = await Promise.all(fetches);

      setTimeData(time);
      setInvoiceData(invoice);
      setExpenseData(expense);
      setProjectData(project);
    } catch (err) {
      console.error("Error fetching report data:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, getDateParams, features]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Calculate financial summary values
  const revenue = features.invoicing && invoiceData
    ? invoiceData.paid
    : timeData?.totalBillable || 0;
  const revenueSource = features.invoicing && invoiceData ? "invoices" : "billable_time";
  const expenses = expenseData?.totalCents;
  const outstanding = invoiceData ? invoiceData.pending + invoiceData.overdue : undefined;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Date picker */}
      <DateRangePicker
        period={period}
        customRange={customRange}
        onPeriodChange={setPeriod}
        onCustomRangeChange={setCustomRange}
      />

      {/* Financial Summary - always shown */}
      <FinancialSummary
        revenue={revenue}
        revenueSource={revenueSource}
        expenses={expenses}
        outstanding={outstanding}
        features={features}
      />

      {/* Time Breakdown - if time_tracking enabled */}
      {features.time_tracking && timeData && (
        <TimeBreakdown
          totalMinutes={timeData.totalMinutes}
          totalBillable={timeData.totalBillable}
          totalUnbillableMinutes={timeData.totalUnbillableMinutes}
          clientBreakdown={timeData.clientBreakdown}
          topProjects={timeData.topProjects}
        />
      )}

      {/* Invoice Status - if invoicing enabled */}
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

      {/* Expense Breakdown - if expenses enabled */}
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

      {/* Project Health - if pm enabled */}
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

      {/* Shared Reports - collapsible */}
      <Collapsible open={sharedReportsOpen} onOpenChange={setSharedReportsOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between">
            <span className="text-lg font-semibold">Shared Reports</span>
            {sharedReportsOpen ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <ReportConfigs orgId={orgId} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
```

**Step 2: Update reports page to pass features**

In `app/(app)/reports/page.tsx`, pass features to the content component:

```typescript
import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ReportsPageContent } from "./reports-page-content";
import { DEFAULT_ORG_FEATURES } from "@/lib/db/schema";

export default async function ReportsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const features = orgData.organization.features || DEFAULT_ORG_FEATURES;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-muted-foreground">
          Analytics and business insights
        </p>
      </div>

      <ReportsPageContent orgId={orgData.organization.id} features={features} />
    </div>
  );
}
```

**Step 3: Delete old reports-content.tsx (no longer needed)**

The functionality is now split across the section components.

**Step 4: Commit**

```bash
git add app/\(app\)/reports/
git rm app/\(app\)/reports/reports-content.tsx
git commit -m "feat(reports): refactor to sectioned dashboard layout"
```

---

## Task 8: Final Testing and Cleanup

**Step 1: Run type check**

```bash
pnpm typecheck
```

Fix any type errors.

**Step 2: Run linter**

```bash
pnpm lint
```

Fix any lint errors.

**Step 3: Manual testing checklist**

- [ ] Visit /reports page
- [ ] Verify period selector works (week/month/quarter/year)
- [ ] Verify custom date range picker works
- [ ] Verify Financial Summary shows (always)
- [ ] Verify Time Breakdown shows when time_tracking enabled
- [ ] Verify Invoice Status shows when invoicing enabled
- [ ] Verify Expense Breakdown shows when expenses enabled
- [ ] Verify Project Health shows when pm enabled
- [ ] Verify Shared Reports collapsible works
- [ ] Test with different feature flag combinations

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(reports): complete expanded dashboard implementation"
```

---

## Summary

This plan implements the expanded reports dashboard in 8 tasks:

1. Add custom date range support to analytics API
2. Create invoice reports API endpoint
3. Create expense reports API endpoint
4. Create project health API endpoint
5. Create date range picker component
6. Create report section components (5 components)
7. Refactor reports page to sectioned dashboard
8. Final testing and cleanup

Each section is independent and respects feature flags. The dashboard loads all data in parallel for performance.
