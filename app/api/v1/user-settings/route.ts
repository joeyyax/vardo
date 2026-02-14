import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userSettings } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

// GET /api/v1/user-settings
export async function GET() {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    let settings = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    });

    // Create default settings if none exist
    if (!settings) {
      const [created] = await db
        .insert(userSettings)
        .values({ userId })
        .returning();
      settings = created;
    }

    return NextResponse.json(settings);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching user settings:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/user-settings
export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    const body = await request.json();
    const { calendarIcsUrl } = body;

    // Build update object
    const updates: Partial<{
      calendarIcsUrl: string | null;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (calendarIcsUrl !== undefined) {
      if (calendarIcsUrl === null || calendarIcsUrl === "") {
        updates.calendarIcsUrl = null;
      } else {
        const trimmed = String(calendarIcsUrl).trim();
        try {
          new URL(trimmed);
        } catch {
          return NextResponse.json(
            { error: "Invalid URL for calendarIcsUrl" },
            { status: 400 },
          );
        }
        updates.calendarIcsUrl = trimmed;
      }
    }

    // Upsert: check if settings exist, then update or create
    const existing = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    });

    let settings;
    if (existing) {
      [settings] = await db
        .update(userSettings)
        .set(updates)
        .where(eq(userSettings.userId, userId))
        .returning();
    } else {
      [settings] = await db
        .insert(userSettings)
        .values({
          userId,
          ...updates,
        })
        .returning();
    }

    return NextResponse.json(settings);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating user settings:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
