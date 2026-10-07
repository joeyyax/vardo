// Every write to apps.status goes through statusChange().

import { eq, sql } from "drizzle-orm";

import { apps } from "@/lib/db/schema";

export type AppStatus = (typeof apps.$inferSelect)["status"];

/** Status write plus its transition stamp, which moves only when the stored status differs. Not for inserts. */
export function statusChange(status: AppStatus, now = new Date()) {
  return {
    status,
    statusChangedAt: sql`case when ${eq(apps.status, status)} then ${apps.statusChangedAt} else ${now.toISOString()}::timestamp end`,
    updatedAt: now,
  };
}
