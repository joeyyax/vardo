import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { session as sessionTable } from "@/lib/db/schema";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { getUserPreferences } from "@/lib/user/preferences";
import type { UiDensity } from "@/lib/db/schema/enums";
import type { Actor } from "./actor";

/** Instance admin only: container discovery reads every host container's env. */
export async function canImportContainers(actor: Actor): Promise<boolean> {
  return actor.instanceAdmin && (await isFeatureEnabledAsync("container-import"));
}

/** The actor's list density preference. */
export async function userDensity(actor: Actor): Promise<UiDensity> {
  return (await getUserPreferences(actor.userId)).density;
}

/** How many unexpired sessions the actor's user has. */
export async function activeSessionCount(actor: Actor): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(sessionTable)
    .where(and(eq(sessionTable.userId, actor.userId), gt(sessionTable.expiresAt, new Date())));
  return row?.total ?? 0;
}
