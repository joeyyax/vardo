import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { meshFetch } from "./client";

/**
 * Send a heartbeat to a peer and update the peer's status locally on success.
 *
 * When this instance pings a peer and gets a 200, it marks the peer online in
 * the local DB. The peer's handler does the same for this instance when it
 * receives the request — that's the bidirectional liveness tracking.
 *
 * Returns true if the peer responded with ok, false if it was unreachable.
 */
export async function sendHeartbeatToPeer(peerId: string): Promise<boolean> {
  let ok = false;
  try {
    const res = await meshFetch(peerId, "/api/v1/mesh/heartbeat", {
      method: "POST",
    });

    ok = res.ok;
  } catch {
    ok = false;
  }

  await db
    .update(meshPeers)
    .set({
      status: ok ? "online" : "offline",
      ...(ok ? { lastSeenAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(meshPeers.id, peerId));

  return ok;
}
