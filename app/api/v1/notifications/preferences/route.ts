import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notificationPreferences } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

// GET /api/v1/notifications/preferences
export async function GET() {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    let prefs = await db.query.notificationPreferences.findFirst({
      where: eq(notificationPreferences.userId, userId),
    });

    // Create default preferences if none exist
    if (!prefs) {
      const [created] = await db
        .insert(notificationPreferences)
        .values({ userId })
        .returning();
      prefs = created;
    }

    return NextResponse.json(prefs);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching notification preferences:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/notifications/preferences
export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    const body = await request.json();
    const {
      assignedToYou,
      mentioned,
      watchedTaskChanged,
      blockerResolved,
      clientComment,
      emailEnabled,
      emailDelivery,
    } = body;

    // Build update object
    const updates: Partial<{
      assignedToYou: boolean;
      mentioned: boolean;
      watchedTaskChanged: boolean;
      blockerResolved: boolean;
      clientComment: boolean;
      emailEnabled: boolean;
      emailDelivery: string;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (assignedToYou !== undefined) updates.assignedToYou = assignedToYou;
    if (mentioned !== undefined) updates.mentioned = mentioned;
    if (watchedTaskChanged !== undefined) updates.watchedTaskChanged = watchedTaskChanged;
    if (blockerResolved !== undefined) updates.blockerResolved = blockerResolved;
    if (clientComment !== undefined) updates.clientComment = clientComment;
    if (emailEnabled !== undefined) updates.emailEnabled = emailEnabled;
    if (emailDelivery !== undefined) updates.emailDelivery = emailDelivery;

    // Check if preferences exist
    const existing = await db.query.notificationPreferences.findFirst({
      where: eq(notificationPreferences.userId, userId),
    });

    let prefs;
    if (existing) {
      [prefs] = await db
        .update(notificationPreferences)
        .set(updates)
        .where(eq(notificationPreferences.userId, userId))
        .returning();
    } else {
      // Create with provided values
      [prefs] = await db
        .insert(notificationPreferences)
        .values({
          userId,
          ...updates,
        })
        .returning();
    }

    return NextResponse.json(prefs);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating notification preferences:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
