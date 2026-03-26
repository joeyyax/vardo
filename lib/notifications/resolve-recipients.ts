import { db } from "@/lib/db";
import { memberships, userNotificationPreferences } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
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
 * Fetch all member user IDs for an org.
 * Call once per dispatch cycle and pass the result to resolveRecipients
 * to avoid querying members once per channel.
 */
export async function fetchOrgMembers(
  orgId: string,
): Promise<{ userId: string }[]> {
  return db.query.memberships.findMany({
    where: eq(memberships.organizationId, orgId),
    columns: { userId: true },
  });
}

/**
 * Determine whether a notification channel should fire for a given event,
 * based on org member preferences.
 *
 * Rules:
 * - Critical events always send, bypassing all preferences.
 * - For each org member: check their preference for this channel+event.
 *   If no row exists, fall back to the channel-type default.
 * - If any member has the event enabled, the channel fires.
 * - If all members have explicitly disabled it, the channel is skipped.
 *
 * Pass pre-fetched `members` so the caller can hoist that query out of
 * the per-channel loop and avoid an N+1.
 */
export async function resolveRecipients(
  orgId: string,
  channelId: string,
  channelType: string,
  eventType: BusEventType,
  members: { userId: string }[],
): Promise<{ shouldSend: boolean }> {
  if (CRITICAL_EVENT_TYPES.has(eventType)) {
    return { shouldSend: true };
  }

  const channelDefault = CHANNEL_TYPE_DEFAULTS[channelType] ?? true;

  if (members.length === 0) {
    return { shouldSend: channelDefault };
  }

  const prefs = await db.query.userNotificationPreferences.findMany({
    where: and(
      eq(userNotificationPreferences.organizationId, orgId),
      eq(userNotificationPreferences.channelId, channelId),
      eq(userNotificationPreferences.eventType, eventType),
    ),
    columns: { userId: true, enabled: true },
  });

  const prefByUser = new Map(prefs.map((p) => [p.userId, p.enabled]));

  for (const { userId } of members) {
    const pref = prefByUser.get(userId);
    const enabled = pref !== undefined ? pref : channelDefault;
    if (enabled) return { shouldSend: true };
  }

  return { shouldSend: false };
}
