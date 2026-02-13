import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifications, notificationPreferences, users } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { DigestEmail } from "@/lib/email/templates/digest";

export async function GET(request: NextRequest) {
  try {
    // Verify cron secret in production
    if (process.env.NODE_ENV === "production") {
      const authHeader = request.headers.get("authorization");
      const cronSecret = process.env.CRON_SECRET;

      if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    if (!isEmailConfigured()) {
      return NextResponse.json({ message: "Email not configured, skipping digest" });
    }

    // Find all users with daily digest enabled
    const digestUsers = await db.query.notificationPreferences.findMany({
      where: and(
        eq(notificationPreferences.emailEnabled, true),
        eq(notificationPreferences.emailDelivery, "daily")
      ),
    });

    let sent = 0;
    let skipped = 0;

    for (const prefs of digestUsers) {
      // Get unsent notifications for this user
      const unsent = await db.query.notifications.findMany({
        where: and(
          eq(notifications.userId, prefs.userId),
          eq(notifications.emailSent, false)
        ),
        orderBy: (notifications, { desc }) => [desc(notifications.createdAt)],
      });

      if (unsent.length === 0) {
        skipped++;
        continue;
      }

      // Get user info
      const user = await db.query.users.findFirst({
        where: eq(users.id, prefs.userId),
        columns: { email: true, name: true },
      });

      if (!user?.email) {
        skipped++;
        continue;
      }

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

      // Send digest email
      const emailSent = await sendEmail({
        to: user.email,
        subject: `You have ${unsent.length} new notification${unsent.length === 1 ? "" : "s"}`,
        react: DigestEmail({
          userName: user.name || "",
          notifications: unsent.map((n) => ({
            type: n.type,
            content: n.content || "",
            createdAt: n.createdAt.toISOString(),
          })),
          viewAllUrl: `${baseUrl}/notifications`,
        }),
      });

      if (emailSent) {
        // Mark all included notifications as email sent
        const ids = unsent.map((n) => n.id);
        for (const id of ids) {
          await db
            .update(notifications)
            .set({ emailSent: true })
            .where(eq(notifications.id, id));
        }
        sent++;
      } else {
        skipped++;
      }
    }

    return NextResponse.json({
      message: "Digest processing complete",
      sent,
      skipped,
      totalUsers: digestUsers.length,
    });
  } catch (error) {
    console.error("Error sending notification digest:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
