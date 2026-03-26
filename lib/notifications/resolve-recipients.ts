import { db } from "@/lib/db";
import { memberships, userNotificationPreferences } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { BusEventType } from "@/lib/bus";
import { CHANNEL_TYPE_DEFAULTS } from "./channel-defaults";

/**
 * Events that always send regardless of user preferences.
 * Users cannot mute these.
 */
export const CRITICAL_EVENT_TYPES: ReadonlySet<BusEventType> = new Set([
  "deploy.failed",
  "security.file-exposed",
  "system.service-down",
  "system.disk-alert",
] as BusEventType[]);

/**
 * Fetch all member user IDs for an org. Called once per dispatch, outside the
 * per-channel loop, to avoid N+1 queries.
 */
export async function fetchOrgMembers(
  orgId: string,
): Promise<Array<{ userId: string }>> {
  return db.query.memberships.findMany({
    where: eq(memberships.organizationId, orgId),
    columns: { userId: true },
  });
}

export type EventPref = { channelId: string; userId: string; enabled: boolean };

/**
 * Fetch all user notification preferences for a given org and event type,
 * scoped to current org members. Called once per dispatch, before the
 * per-channel loop, to eliminate the per-channel prefs query.
 *
 * The userId IN (...) filter excludes stale rows left behind by ex-members.
 */
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
 * Determine whether a notification channel should fire for a given event,
 * based on org member preferences.
 *
 * Accepts pre-fetched `members` and `prefs` so both queries are hoisted out
 * of the per-channel loop. No DB calls are made here.
 *
 * Rules:
 * - Critical events always send, bypassing all preferences.
 * - For each org member: check their preference for this channel+event.
 *   If no row exists, fall back to the channel-type default.
 * - If any member has the event enabled, the channel fires.
 * - If all members have explicitly disabled it, the channel is skipped.
 */
export function resolveRecipients(
  channelId: string,
  channelType: string,
  eventType: BusEventType,
  members: Array<{ userId: string }>,
  prefs: EventPref[],
): { shouldSend: boolean } {
  if (CRITICAL_EVENT_TYPES.has(eventType)) {
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
