import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import type { BusEvent } from "@/lib/bus/events";
import { eventAppIds } from "@/lib/bus/event-scope";
import { channelAcceptsEvent } from "./channel-defaults";
import { logger } from "@/lib/logger";

const log = logger.child("notifications");

/** The projects an event's apps belong to, child apps through their parent. Null means org-level. */
export async function eventProjectIds(orgId: string, event: BusEvent): Promise<string[] | null> {
  const appIds = eventAppIds(event);
  if (!appIds) return null;
  const parent = alias(apps, "parent");
  const rows = await db
    .select({ projectId: sql<string>`coalesce(${parent.projectId}, ${apps.projectId})` })
    .from(apps)
    .leftJoin(parent, eq(parent.id, apps.parentAppId))
    .where(and(eq(apps.organizationId, orgId), inArray(apps.id, appIds)));
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter(Boolean))];
  return projectIds.length > 0 ? projectIds : null;
}

/** Whether a channel's project filter lets the event through. Empty filters and org-level events always pass. */
export function channelAcceptsProjects(channelProjectIds: string[], eventProjects: string[] | null): boolean {
  if (channelProjectIds.length === 0 || eventProjects === null) return true;
  return eventProjects.some((id) => channelProjectIds.includes(id));
}

type FilterableChannel = { subscribedEvents: string[]; projectIds: string[] };

/** The channels whose event and project filters let this event through. */
export async function channelsForEvent<T extends FilterableChannel>(
  orgId: string,
  event: BusEvent,
  channels: T[],
): Promise<T[]> {
  const byEvent = channels.filter((c) => channelAcceptsEvent(c.subscribedEvents, event.type));
  if (!byEvent.some((c) => c.projectIds.length > 0)) return byEvent;
  let projects: string[] | null;
  try {
    projects = await eventProjectIds(orgId, event);
  } catch (err) {
    // Unresolved events go everywhere.
    log.warn(`Couldn't resolve projects for ${event.type}: ${err instanceof Error ? err.message : String(err)}`);
    projects = null;
  }
  return byEvent.filter((c) => channelAcceptsProjects(c.projectIds, projects));
}
