import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExpenses, projects, EXPENSE_STATUSES, type ExpenseStatus } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; expenseId: string }>;
};

// GET /api/v1/organizations/[orgId]/expenses/[expenseId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.organizationId, orgId)
      ),
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

    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    return NextResponse.json(expense);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching expense:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/expenses/[expenseId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.organizationId, orgId)
      ),
    });

    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    const body = await request.json();
    const {
      description,
      amountCents,
      date,
      category,
      projectId,
      isBillable,
      receiptFileId,
      isRecurring,
      recurringFrequency,
      nextOccurrence,
      recurringEndDate,
      vendor,
      status,
      paidAt,
    } = body;

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (typeof description === "string" && description.trim()) {
      updateData.description = description.trim();
    }
    if (typeof amountCents === "number" && amountCents > 0) {
      updateData.amountCents = Math.round(amountCents);
    }
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      updateData.date = date;
    }
    if (category !== undefined) {
      updateData.category = category?.trim() || null;
    }
    if (vendor !== undefined) {
      updateData.vendor = vendor?.trim() || null;
    }
    if (status !== undefined && EXPENSE_STATUSES.includes(status as ExpenseStatus)) {
      updateData.status = status as ExpenseStatus;
    }
    if (paidAt !== undefined) {
      updateData.paidAt = paidAt;
    }
    if (typeof isBillable === "boolean") {
      updateData.isBillable = isBillable;
    }
    if (receiptFileId !== undefined) {
      updateData.receiptFileId = receiptFileId || null;
    }

    // Handle project change
    if (projectId !== undefined) {
      if (projectId === null) {
        // Convert to overhead expense
        updateData.projectId = null;
        updateData.isBillable = false; // Can't bill overhead
      } else {
        // Verify project belongs to org
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
        updateData.projectId = projectId;
      }
    }

    // Handle recurring fields
    if (typeof isRecurring === "boolean") {
      updateData.isRecurring = isRecurring;
      if (!isRecurring) {
        // Clear recurring fields when disabling
        updateData.recurringFrequency = null;
        updateData.nextOccurrence = null;
        updateData.recurringEndDate = null;
      }
    }
    if (recurringFrequency !== undefined) {
      updateData.recurringFrequency = recurringFrequency || null;
    }
    if (nextOccurrence !== undefined) {
      updateData.nextOccurrence = nextOccurrence || null;
    }
    if (recurringEndDate !== undefined) {
      updateData.recurringEndDate = recurringEndDate || null;
    }

    const [updated] = await db
      .update(projectExpenses)
      .set(updateData)
      .where(eq(projectExpenses.id, expenseId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating expense:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/expenses/[expenseId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.organizationId, orgId)
      ),
    });

    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    await db.delete(projectExpenses).where(eq(projectExpenses.id, expenseId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error deleting expense:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
