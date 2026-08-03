// ---------------------------------------------------------------------------
// App status writes
//
// Every writer of apps.status goes through statusChange(), so status and the
// stamp that says how long it has held cannot drift apart.
// ---------------------------------------------------------------------------

import { eq, sql } from "drizzle-orm";

import { apps } from "@/lib/db/schema";

export type AppStatus = (typeof apps.$inferSelect)["status"];

/**
 * Status write plus its transition stamp. The stamp moves only when the status
 * actually differs, evaluated per row against the value already stored — a
 * compose refresh, a reconciler pass or a bulk cascade that rewrites the same
 * status leaves it alone.
 *
 * Not used on insert: a new app has never transitioned, and null reads as
 * "how long is unknown" rather than a duration measured from nothing.
 */
export function statusChange(status: AppStatus, now = new Date()) {
  return {
    status,
    statusChangedAt: sql`case when ${eq(apps.status, status)} then ${apps.statusChangedAt} else ${now.toISOString()}::timestamp end`,
    updatedAt: now,
  };
}
