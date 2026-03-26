import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { userNotificationPreferences } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * DELETE /api/v1/user/notification-preferences/:id
 *
 * Removes a preference row, reverting to the channel-type default for
 * that event.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
) {
  try {
    const session = await requireSession();
    const userId = session.user.id;
    const { id } = await params;

    const pref = await db.query.userNotificationPreferences.findFirst({
      where: and(
        eq(userNotificationPreferences.id, id),
        eq(userNotificationPreferences.userId, userId),
      ),
      columns: { id: true },
    });

    if (!pref) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await db
      .delete(userNotificationPreferences)
      .where(eq(userNotificationPreferences.id, id));

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting notification preference");
  }
}
