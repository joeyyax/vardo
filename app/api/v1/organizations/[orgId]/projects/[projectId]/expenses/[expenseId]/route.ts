import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExpenses, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; expenseId: string }>;
};

/**
 * Verify that the project belongs to the organization.
 */
async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: true,
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }

  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/expenses/[expenseId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.projectId, projectId)
      ),
      with: {
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

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/expenses/[expenseId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.projectId, projectId)
      ),
    });

    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    const body = await request.json();
    const { description, amountCents, date, category, isBillable, receiptFileId } = body;

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
    if (typeof isBillable === "boolean") {
      updateData.isBillable = isBillable;
    }
    if (receiptFileId !== undefined) {
      updateData.receiptFileId = receiptFileId || null;
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

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/expenses/[expenseId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.projectId, projectId)
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
