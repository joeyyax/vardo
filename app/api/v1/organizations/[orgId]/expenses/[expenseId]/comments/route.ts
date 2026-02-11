import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenseComments, projectExpenses, expenseWatchers, users } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";
import { logCommentAdded } from "@/lib/activities";
import { notifyExpenseWatchers } from "@/lib/notifications";

type RouteParams = {
  params: Promise<{ orgId: string; expenseId: string }>;
};

// Auto-add commenter as watcher
async function ensureWatcher(expenseId: string, userId: string, reason: string) {
  const existing = await db.query.expenseWatchers.findFirst({
    where: and(
      eq(expenseWatchers.expenseId, expenseId),
      eq(expenseWatchers.userId, userId)
    ),
  });

  if (!existing) {
    await db.insert(expenseWatchers).values({
      expenseId,
      userId,
      reason,
    });
  }
}

// GET /api/v1/organizations/[orgId]/expenses/[expenseId]/comments
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, expenseId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

    const comments = await db.query.expenseComments.findMany({
      where: eq(expenseComments.expenseId, expenseId),
      orderBy: [desc(expenseComments.createdAt)],
      with: {
        author: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        sharedByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return NextResponse.json(comments);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching expense comments:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/expenses/[expenseId]/comments
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

    const body = await request.json();
    const { content, isShared } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const [comment] = await db
      .insert(expenseComments)
      .values({
        expenseId,
        authorId: session.user.id,
        content: content.trim(),
        isShared: isShared ?? false,
        sharedAt: isShared ? new Date() : null,
        sharedBy: isShared ? session.user.id : null,
      })
      .returning();

    // Auto-watch on comment
    await ensureWatcher(expenseId, session.user.id, "commenter");

    // Log activity
    await logCommentAdded({
      organizationId: orgId,
      actorId: session.user.id,
      expenseId,
      commentId: comment.id,
      isShared: comment.isShared ?? false,
    });

    // Notify watchers about the comment
    const actor = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { name: true, email: true },
    });
    const actorName = actor?.name || actor?.email || "Someone";

    await notifyExpenseWatchers({
      expenseId,
      actorId: session.user.id,
      actorName,
      isShared: comment.isShared ?? false,
    });

    // Fetch the comment with author info
    const commentWithAuthor = await db.query.expenseComments.findFirst({
      where: eq(expenseComments.id, comment.id),
      with: {
        author: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        sharedByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return NextResponse.json(commentWithAuthor, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating expense comment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
