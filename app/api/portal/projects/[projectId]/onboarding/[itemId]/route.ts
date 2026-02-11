import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectInvitations, onboardingItems } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, and, or } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ projectId: string; itemId: string }>;
};

// PATCH — toggle onboarding item from portal (client-facing)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId, itemId } = await params;
    const session = await getSession();

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify user has access to this project via invitation
    const invitation = await db.query.projectInvitations.findFirst({
      where: and(
        eq(projectInvitations.projectId, projectId),
        or(
          eq(projectInvitations.userId, session.user.id),
          eq(
            projectInvitations.email,
            session.user.email?.toLowerCase() ?? ""
          )
        )
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Contributors can toggle items
    if (invitation.role !== "contributor") {
      return NextResponse.json(
        { error: "Only contributors can update checklist items" },
        { status: 403 }
      );
    }

    // Get the item
    const item = await db.query.onboardingItems.findFirst({
      where: and(
        eq(onboardingItems.id, itemId),
        eq(onboardingItems.projectId, projectId)
      ),
    });

    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    const body = await request.json();
    const isCompleted = body.isCompleted ?? !item.isCompleted;

    const [updated] = await db
      .update(onboardingItems)
      .set({
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
        completedBy: isCompleted ? session.user.id : null,
      })
      .where(
        and(
          eq(onboardingItems.id, itemId),
          eq(onboardingItems.projectId, projectId)
        )
      )
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error toggling portal onboarding item:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
