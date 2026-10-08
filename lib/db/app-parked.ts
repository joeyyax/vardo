// Parked means an operator stopped the app. Stop sets it; start and deploy clear it.

import { eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";

/** Sets the operator-stopped flag on an app and every compose child under it. */
export async function setParked(appId: string, parked: boolean, now = new Date()): Promise<void> {
  await db
    .update(apps)
    .set({ parked, updatedAt: now })
    .where(or(eq(apps.id, appId), eq(apps.parentAppId, appId)));
}
