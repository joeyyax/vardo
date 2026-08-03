// ---------------------------------------------------------------------------
// Parked writes
//
// Parked is a declaration, not an observation. An operator sets it; starting or
// deploying clears it. Stopping does not set it, and the reconciler never
// touches it, so a container Docker brought back on its own leaves it standing.
// ---------------------------------------------------------------------------

import { eq, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";

/**
 * Park or unpark an app and every compose child under it, the way stopApp
 * writes its status to the parent and then the whole stack. Reads check the row
 * in front of them rather than walking back up to a parent.
 */
export async function setParked(appId: string, parked: boolean, now = new Date()): Promise<void> {
  await db
    .update(apps)
    .set({ parked, updatedAt: now })
    .where(or(eq(apps.id, appId), eq(apps.parentAppId, appId)));
}
