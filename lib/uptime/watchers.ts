// Which vantage points check each monitor, so they can share the load: each checks every interval x N.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers, uptimeVantages } from "@/lib/db/schema";
import { LOCAL_VANTAGE_ID } from "./vantage";

/** Monitor id to the external vantage points that check it. Peers that are offline are left out, so a dead peer doesn't slow the rest. */
export async function externalWatchers(): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ id: uptimeVantages.id, watching: uptimeVantages.watching })
    .from(uptimeVantages)
    .innerJoin(meshPeers, eq(meshPeers.id, uptimeVantages.meshPeerId))
    .where(eq(meshPeers.status, "online"));
  const out = new Map<string, string[]>();
  for (const v of rows) {
    for (const monitorId of v.watching) {
      const list = out.get(monitorId);
      if (list) list.push(v.id);
      else out.set(monitorId, [v.id]);
    }
  }
  return out;
}

/** The vantage points sharing a monitor, the local one included. */
export const sharing = (watchers: Map<string, string[]>, monitorId: string): string[] => [LOCAL_VANTAGE_ID, ...(watchers.get(monitorId) ?? [])];
