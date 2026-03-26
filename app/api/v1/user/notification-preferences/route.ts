import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import {
  notificationChannels,
  userNotificationPreferences,
  userDigestPreferences,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ALL_EVENT_TYPES } from "@/lib/bus/events";

/**
 * Discriminated union for PUT — the `type` field routes the request cleanly
 * without ambiguous fallthrough between digest and preference updates.
 */
const putSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("preference"),
    orgId: z.string().min(1),
    channelId: z.string().min(1),
    eventType: z.enum(ALL_EVENT_TYPES as [string, ...string[]]),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("digest"),
    orgId: z.string().min(1),
    digestEnabled: z.boolean(),
  }),
]);

/**
 * GET /api/v1/user/notification-preferences?orgId=xxx
 *
 * Returns the current user's notification preferences for all channels in
 * the given org, plus their digest preference.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    const orgId = req.nextUrl.searchParams.get("orgId");
    if (!orgId) {
      return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    }

    const [channels, prefs, digestPref] = await Promise.all([
      db.query.notificationChannels.findMany({
        where: eq(notificationChannels.organizationId, orgId),
        columns: { id: true, name: true, type: true, enabled: true },
      }),
      db.query.userNotificationPreferences.findMany({
        where: and(
          eq(userNotificationPreferences.userId, userId),
          eq(userNotificationPreferences.organizationId, orgId),
        ),
        columns: {
          id: true,
          channelId: true,
          eventType: true,
          enabled: true,
        },
      }),
      db.query.userDigestPreferences.findFirst({
        where: and(
          eq(userDigestPreferences.userId, userId),
          eq(userDigestPreferences.organizationId, orgId),
        ),
        columns: { id: true, enabled: true },
      }),
    ]);

    return NextResponse.json({
      channels,
      preferences: prefs,
      digestEnabled: digestPref?.enabled ?? false,
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching notification preferences");
  }
}

/**
 * PUT /api/v1/user/notification-preferences
 *
 * Upserts a single preference row (type: "preference") or updates the
 * digest toggle (type: "digest"). The `type` discriminant ensures clean
 * routing with no ambiguous fallthrough.
 */
export async function PUT(req: NextRequest) {
  try {
    const session = await requireSession();
    const userId = session.user.id;

    const body = await req.json();
    const parsed = putSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    if (parsed.data.type === "digest") {
      const { orgId, digestEnabled } = parsed.data;

      const existing = await db.query.userDigestPreferences.findFirst({
        where: and(
          eq(userDigestPreferences.userId, userId),
          eq(userDigestPreferences.organizationId, orgId),
        ),
        columns: { id: true },
      });

      if (existing) {
        await db
          .update(userDigestPreferences)
          .set({ enabled: digestEnabled, updatedAt: new Date() })
          .where(eq(userDigestPreferences.id, existing.id));
      } else {
        await db.insert(userDigestPreferences).values({
          id: nanoid(),
          userId,
          organizationId: orgId,
          enabled: digestEnabled,
        });
      }

      return NextResponse.json({ ok: true });
    }

    // type === "preference"
    const { orgId, channelId, eventType, enabled } = parsed.data;

    // Verify the channel belongs to the org
    const channel = await db.query.notificationChannels.findFirst({
      where: and(
        eq(notificationChannels.id, channelId),
        eq(notificationChannels.organizationId, orgId),
      ),
      columns: { id: true },
    });

    if (!channel) {
      return NextResponse.json(
        { error: "Channel not found" },
        { status: 404 },
      );
    }

    const existing = await db.query.userNotificationPreferences.findFirst({
      where: and(
        eq(userNotificationPreferences.userId, userId),
        eq(userNotificationPreferences.organizationId, orgId),
        eq(userNotificationPreferences.channelId, channelId),
        eq(userNotificationPreferences.eventType, eventType),
      ),
      columns: { id: true },
    });

    if (existing) {
      await db
        .update(userNotificationPreferences)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(userNotificationPreferences.id, existing.id));
    } else {
      await db.insert(userNotificationPreferences).values({
        id: nanoid(),
        userId,
        organizationId: orgId,
        channelId,
        eventType,
        enabled,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error saving notification preference");
  }
}
