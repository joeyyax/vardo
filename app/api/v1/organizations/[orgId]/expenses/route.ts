import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExpenses, projects, EXPENSE_STATUSES, type ExpenseStatus } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { getAccessibleProjectIds } from "@/lib/auth/permissions";
import { eq, and, desc, gte, lte, isNull, inArray } from "drizzle-orm";
import { addWeeks, addMonths, addQuarters, addYears, isBefore, startOfDay } from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/expenses
// List all expenses in the organization (both project-specific and overhead)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const accessibleProjectIds = await getAccessibleProjectIds(session.user.id, membership.role);

    // Get optional filters
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const category = searchParams.get("category");
    const projectId = searchParams.get("projectId");
    const billableOnly = searchParams.get("billable") === "true";
    const overheadOnly = searchParams.get("overhead") === "true";
    const recurringOnly = searchParams.get("recurring") === "true";
    const clientId = searchParams.get("clientId");
    const vendor = searchParams.get("vendor");
    const status = searchParams.get("status");

    // Build where conditions - always filter by org
    const whereConditions = [eq(projectExpenses.organizationId, orgId)];

    if (startDate) {
      whereConditions.push(gte(projectExpenses.date, startDate));
    }
    if (endDate) {
      whereConditions.push(lte(projectExpenses.date, endDate));
    }
    if (category) {
      whereConditions.push(eq(projectExpenses.category, category));
    }
    if (billableOnly) {
      whereConditions.push(eq(projectExpenses.isBillable, true));
    }
    if (overheadOnly) {
      // Only show expenses without a project (general business expenses)
      whereConditions.push(isNull(projectExpenses.projectId));
    } else if (projectId) {
      // Filter to specific project
      whereConditions.push(eq(projectExpenses.projectId, projectId));
    }
    if (recurringOnly) {
      whereConditions.push(eq(projectExpenses.isRecurring, true));
    }
    if (vendor) {
      whereConditions.push(eq(projectExpenses.vendor, vendor));
    }
    if (status && EXPENSE_STATUSES.includes(status as ExpenseStatus)) {
      whereConditions.push(eq(projectExpenses.status, status as ExpenseStatus));
    }

    // Members can only see their own expenses for assigned projects (no overhead)
    if (accessibleProjectIds !== null) {
      whereConditions.push(eq(projectExpenses.createdBy, session.user.id));
      if (accessibleProjectIds.length === 0) {
        return NextResponse.json({
          expenses: [],
          summary: { totalCents: 0, billableCents: 0, nonBillableCents: 0, overheadCents: 0, count: 0 },
          categories: [],
          vendors: [],
        });
      }
      whereConditions.push(inArray(projectExpenses.projectId, accessibleProjectIds));
    }

    const expenses = await db.query.projectExpenses.findMany({
      where: and(...whereConditions),
      orderBy: [desc(projectExpenses.date), desc(projectExpenses.createdAt)],
      with: {
        project: {
          columns: {
            id: true,
            name: true,
          },
          with: {
            client: {
              columns: {
                id: true,
                name: true,
                color: true,
              },
            },
          },
        },
        receiptFile: {
          columns: {
            id: true,
            name: true,
            mimeType: true,
          },
        },
        createdByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Post-query filter for clientId (needs to filter through project relation)
    let filteredExpenses = expenses;
    if (clientId) {
      filteredExpenses = expenses.filter(
        (e) => e.project?.client?.id === clientId
      );
    }

    // Get all expenses for summary (unfiltered by date/category but filtered by org)
    // Summary is intentionally unfiltered - shows total org expenses regardless of current filter
    // For members: scoped to own expenses in assigned projects only
    const summaryConditions = [eq(projectExpenses.organizationId, orgId)];
    if (accessibleProjectIds !== null) {
      summaryConditions.push(eq(projectExpenses.createdBy, session.user.id));
      summaryConditions.push(inArray(projectExpenses.projectId, accessibleProjectIds));
    }
    const allExpenses = await db.query.projectExpenses.findMany({
      where: and(...summaryConditions),
      columns: {
        amountCents: true,
        isBillable: true,
        category: true,
        projectId: true,
        vendor: true,
      },
    });

    const totalCents = allExpenses.reduce((sum, e) => sum + e.amountCents, 0);
    const billableCents = allExpenses
      .filter((e) => e.isBillable)
      .reduce((sum, e) => sum + e.amountCents, 0);
    const overheadCents = allExpenses
      .filter((e) => !e.projectId)
      .reduce((sum, e) => sum + e.amountCents, 0);

    // Get unique categories
    const categories = [...new Set(allExpenses.map((e) => e.category).filter(Boolean))].sort();

    // Get unique vendors
    const vendors = [...new Set(allExpenses.map((e) => e.vendor).filter(Boolean))].sort();

    return NextResponse.json({
      expenses: clientId ? filteredExpenses : expenses,
      summary: {
        totalCents,
        billableCents,
        nonBillableCents: totalCents - billableCents,
        overheadCents,
        count: allExpenses.length,
      },
      categories,
      vendors,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching expenses:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/expenses
// Create a new expense (project is optional)
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session: orgSession, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const accessibleProjectIds = await getAccessibleProjectIds(session.user.id, membership.role);

    const body = await request.json();
    const {
      projectId, // Optional - null means overhead/general expense
      description,
      amountCents,
      date,
      category,
      isBillable,
      receiptFileId,
      isRecurring,
      recurringFrequency,
      nextOccurrence,
      recurringEndDate,
      backfillRecurring, // Whether to create entries between date and end date
      backfillEndDate, // End date for backfill (defaults to today if not provided)
      vendor,
      status,
      paidAt,
    } = body;

    // Validate required fields
    if (!description || typeof description !== "string" || !description.trim()) {
      return NextResponse.json({ error: "Description is required" }, { status: 400 });
    }
    if (typeof amountCents !== "number" || amountCents <= 0) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
    }
    if (!date || typeof date !== "string") {
      return NextResponse.json({ error: "Date is required" }, { status: 400 });
    }

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
    }

    // If projectId is provided, verify it belongs to this org
    if (projectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: {
          client: {
            columns: { organizationId: true },
          },
        },
      });

      if (!project || project.client.organizationId !== orgId) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
    }

    // Members must specify a project and it must be one they're assigned to
    if (accessibleProjectIds !== null) {
      if (!projectId) {
        return NextResponse.json(
          { error: "Project is required" },
          { status: 400 }
        );
      }
      if (!accessibleProjectIds.includes(projectId)) {
        return NextResponse.json(
          { error: "You do not have access to this project" },
          { status: 403 }
        );
      }
    }

    // Validate status if provided
    const validStatus = (status && EXPENSE_STATUSES.includes(status as ExpenseStatus))
      ? (status as ExpenseStatus)
      : "paid";

    const [expense] = await db
      .insert(projectExpenses)
      .values({
        organizationId: orgId,
        projectId: projectId || null,
        description: description.trim(),
        amountCents: Math.round(amountCents),
        date,
        category: category?.trim() || null,
        isBillable: isBillable === true,
        receiptFileId: receiptFileId || null,
        isRecurring: isRecurring === true,
        recurringFrequency: isRecurring ? recurringFrequency : null,
        nextOccurrence: isRecurring ? nextOccurrence : null,
        recurringEndDate: recurringEndDate || null,
        vendor: vendor?.trim() || null,
        status: validStatus,
        paidAt: paidAt || null,
        createdBy: session.user.id,
      })
      .returning();

    // Handle backfill for recurring expenses
    let created = 1;
    if (isRecurring && backfillRecurring && recurringFrequency) {
      const startDate = new Date(date + "T12:00:00"); // Noon to avoid timezone issues
      // Use provided end date or default to today
      const endDate = backfillEndDate
        ? startOfDay(new Date(backfillEndDate + "T12:00:00"))
        : startOfDay(new Date());

      // Calculate the add function based on frequency
      const addPeriod = (d: Date): Date => {
        switch (recurringFrequency) {
          case "weekly": return addWeeks(d, 1);
          case "monthly": return addMonths(d, 1);
          case "quarterly": return addQuarters(d, 1);
          case "yearly": return addYears(d, 1);
          default: return addMonths(d, 1);
        }
      };

      // Generate dates from start to end date
      const backfillDates: string[] = [];
      let currentDate = addPeriod(startDate);

      while (isBefore(currentDate, endDate) || currentDate.toDateString() === endDate.toDateString()) {
        const dateStr = currentDate.toISOString().split("T")[0];
        backfillDates.push(dateStr);
        currentDate = addPeriod(currentDate);
      }

      // Create backfilled entries
      if (backfillDates.length > 0) {
        await db.insert(projectExpenses).values(
          backfillDates.map((backfillDate) => ({
            organizationId: orgId,
            projectId: projectId || null,
            description: description.trim(),
            amountCents: Math.round(amountCents),
            date: backfillDate,
            category: category?.trim() || null,
            isBillable: isBillable === true,
            receiptFileId: null, // Don't copy receipt
            isRecurring: true,
            recurringFrequency,
            parentExpenseId: expense.id, // Link to the original expense
            createdBy: session.user.id,
          }))
        );
        created += backfillDates.length;
      }
    }

    return NextResponse.json({ expense, created }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating expense:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
