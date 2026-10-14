import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import {
  notificationChannels,
  projects,
  projectWatches,
  userNotificationPreferences,
  userDigestPreferences,
} from "@/lib/db/schema";
import { requireSession, isScopedToken } from "@/lib/auth/session";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ALL_EVENT_TYPES } from "@/lib/bus/events";
import { DIGEST_FREQUENCIES, frequencyFor } from "@/lib/digest/window";

import { withRateLimit } from "@/lib/api/with-rate-limit";

/** PUT body, discriminated by `type`. */
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
    frequency: z.enum(DIGEST_FREQUENCIES),
  }),
  z.object({
    type: z.literal("watch"),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    watching: z.boolean(),
  }),
]);

/** GET ?orgId= — the user's preferences for every channel in the org, their digest frequency and the projects they watch. */
async function handleGet(req: NextRequest) {
  try {
    const orgId = req.nextUrl.searchParams.get("orgId");
    if (!orgId) {
      return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    }

    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();
    const userId = org.session.user.id;

    const [channels, prefs, digestPref, orgProjects, watches] = await Promise.all([
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
        columns: { frequency: true },
      }),
      db.query.projects.findMany({
        where: and(eq(projects.organizationId, orgId), eq(projects.isSystemManaged, false)),
        columns: { id: true, name: true, displayName: true },
        orderBy: (p, { asc }) => [asc(p.displayName)],
      }),
      db
        .select({ projectId: projectWatches.projectId })
        .from(projectWatches)
        .innerJoin(projects, eq(projects.id, projectWatches.projectId))
        .where(and(eq(projectWatches.userId, userId), eq(projects.organizationId, orgId))),
    ]);

    return NextResponse.json({
      channels,
      preferences: prefs,
      digestFrequency: frequencyFor(digestPref),
      projects: orgProjects.map((p) => ({ id: p.id, name: p.displayName || p.name })),
      watching: watches.map((w) => w.projectId),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching notification preferences");
  }
}

/** PUT — upserts a channel preference, the digest frequency, or a project watch. */
async function handlePut(req: NextRequest) {
  try {
    const session = await requireSession();
    // A scoped token only acts through org capabilities.
    if (isScopedToken(session)) return apiError.forbidden();

    const body = await req.json();
    const parsed = putSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const org = await verifyOrgAccess(parsed.data.orgId, "org.view");
    if (!org) return apiError.forbidden();
    const userId = org.session.user.id;

    if (parsed.data.type === "digest") {
      const { orgId, frequency } = parsed.data;
      const now = new Date();
      await db
        .insert(userDigestPreferences)
        .values({ id: nanoid(), userId, organizationId: orgId, frequency })
        .onConflictDoUpdate({
          target: [userDigestPreferences.userId, userDigestPreferences.organizationId],
          set: { frequency, updatedAt: now },
        });
      return NextResponse.json({ ok: true, frequency });
    }

    if (parsed.data.type === "watch") {
      const { orgId, projectId, watching } = parsed.data;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
        columns: { id: true },
      });
      if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
      if (watching) {
        await db.insert(projectWatches).values({ userId, projectId }).onConflictDoNothing();
      } else {
        await db.delete(projectWatches).where(and(eq(projectWatches.userId, userId), eq(projectWatches.projectId, projectId)));
      }
      return NextResponse.json({ ok: true, watching });
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

export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "user-notification-preferences" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/user/notification-preferences" });
