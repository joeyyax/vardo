import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenseComments, projectExpenses } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; expenseId: string; commentId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/expenses/[expenseId]/comments/[commentId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId, commentId } = await params;
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

    // Verify comment exists and user is author
    const comment = await db.query.expenseComments.findFirst({
      where: and(
        eq(expenseComments.id, commentId),
        eq(expenseComments.expenseId, expenseId)
      ),
    });

    if (!comment) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    if (comment.authorId !== session.user.id) {
      return NextResponse.json({ error: "Can only edit your own comments" }, { status: 403 });
    }

    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const [updated] = await db
      .update(expenseComments)
      .set({
        content: content.trim(),
        updatedAt: new Date(),
      })
      .where(eq(expenseComments.id, commentId))
      .returning();

    // Fetch with author
    const commentWithAuthor = await db.query.expenseComments.findFirst({
      where: eq(expenseComments.id, updated.id),
      with: {
        author: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    return NextResponse.json(commentWithAuthor);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating expense comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/expenses/[expenseId]/comments/[commentId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId, commentId } = await params;
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

    // Verify comment exists and user is author
    const comment = await db.query.expenseComments.findFirst({
      where: and(
        eq(expenseComments.id, commentId),
        eq(expenseComments.expenseId, expenseId)
      ),
    });

    if (!comment) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    if (comment.authorId !== session.user.id) {
      return NextResponse.json({ error: "Can only delete your own comments" }, { status: 403 });
    }

    await db.delete(expenseComments).where(eq(expenseComments.id, commentId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error deleting expense comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
