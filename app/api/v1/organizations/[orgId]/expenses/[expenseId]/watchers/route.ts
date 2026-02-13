import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenseWatchers, projectExpenses } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; expenseId: string }>;
};

// GET /api/v1/organizations/[orgId]/expenses/[expenseId]/watchers
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    const currentUserId = session?.user?.id;

    // Verify expense belongs to org
    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.organizationId, orgId)
      ),
    });

    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    const watchers = await db.query.expenseWatchers.findMany({
      where: eq(expenseWatchers.expenseId, expenseId),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    const isWatching = currentUserId
      ? watchers.some((w) => w.userId === currentUserId)
      : false;

    return NextResponse.json({
      watchers,
      isWatching,
      count: watchers.length,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching expense watchers:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/expenses/[expenseId]/watchers
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify expense belongs to org
    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.organizationId, orgId)
      ),
    });

    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    // Check for duplicate
    const existing = await db.query.expenseWatchers.findFirst({
      where: and(
        eq(expenseWatchers.expenseId, expenseId),
        eq(expenseWatchers.userId, session.user.id)
      ),
    });

    if (existing) {
      return NextResponse.json({ error: "Already watching" }, { status: 409 });
    }

    await db.insert(expenseWatchers).values({
      expenseId,
      userId: session.user.id,
      reason: "manual",
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error adding expense watcher:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/expenses/[expenseId]/watchers
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify expense belongs to org
    const expense = await db.query.projectExpenses.findFirst({
      where: and(
        eq(projectExpenses.id, expenseId),
        eq(projectExpenses.organizationId, orgId)
      ),
    });

    if (!expense) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }

    await db
      .delete(expenseWatchers)
      .where(
        and(
          eq(expenseWatchers.expenseId, expenseId),
          eq(expenseWatchers.userId, session.user.id)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error removing expense watcher:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
