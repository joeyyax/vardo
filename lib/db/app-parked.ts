// Parked is set by an operator and cleared by start or deploy. Stopping and the reconciler never touch it.

import { eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";

/** Parks or unparks an app and every compose child under it. */
export async function setParked(appId: string, parked: boolean, now = new Date()): Promise<void> {
  await db
    .update(apps)
    .set({ parked, updatedAt: now })
    .where(or(eq(apps.id, appId), eq(apps.parentAppId, appId)));
}
