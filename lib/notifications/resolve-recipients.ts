import { db } from "@/lib/db";
import { memberships, userNotificationPreferences } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { BusEventType } from "@/lib/bus";
import { CHANNEL_TYPE_DEFAULTS, CRITICAL_EVENT_TYPES } from "./channel-defaults";
import { SILENT_EVENT_TYPES } from "./ui-only";

/** Fetches all member user IDs for an org, once per dispatch. */
export async function fetchOrgMembers(
  orgId: string,
): Promise<Array<{ userId: string }>> {
  return db.query.memberships.findMany({
    where: eq(memberships.organizationId, orgId),
    columns: { userId: true },
  });
}

export type EventPref = { channelId: string; userId: string; enabled: boolean };

/** Fetches current members' notification preferences for an org and event type, once per dispatch. */
export async function fetchEventPrefs(
  orgId: string,
  eventType: BusEventType,
  memberIds: string[],
): Promise<EventPref[]> {
  if (memberIds.length === 0) return [];
  return db.query.userNotificationPreferences.findMany({
    where: and(
      eq(userNotificationPreferences.organizationId, orgId),
      eq(userNotificationPreferences.eventType, eventType),
      inArray(userNotificationPreferences.userId, memberIds),
    ),
    columns: { channelId: true, userId: true, enabled: true },
  });
}

/**
 * Whether a channel fires for an event: live-UI-only never, critical always,
 * otherwise if any member has it enabled (missing prefs use the channel default).
 */
export function resolveRecipients(
  channelId: string,
  channelType: string,
  eventType: BusEventType,
  members: Array<{ userId: string }>,
  prefs: EventPref[],
  critical = CRITICAL_EVENT_TYPES.has(eventType),
): { shouldSend: boolean } {
  if (SILENT_EVENT_TYPES.has(eventType)) {
    return { shouldSend: false };
  }

  if (critical) {
    return { shouldSend: true };
  }

  const channelDefault = CHANNEL_TYPE_DEFAULTS[channelType] ?? true;

  if (members.length === 0) {
    return { shouldSend: channelDefault };
  }

  const channelPrefs = prefs.filter((p) => p.channelId === channelId);
  const prefByUser = new Map(channelPrefs.map((p) => [p.userId, p.enabled]));

  for (const { userId } of members) {
    const pref = prefByUser.get(userId);
    const enabled = pref !== undefined ? pref : channelDefault;
    if (enabled) return { shouldSend: true };
  }

  return { shouldSend: false };
}
