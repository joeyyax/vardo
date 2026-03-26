import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getInstanceId } from "@/lib/constants";
import { meshFetch } from "./client";

/**
 * Send a heartbeat to a peer and update the peer's status locally on success.
 *
 * This is the client side of the bidirectional heartbeat: when this instance
 * sends a heartbeat to a peer and receives a 200, it treats the peer as online
 * and records the contact time locally. The peer's handler does the same for
 * this instance.
 *
 * Returns true if the peer responded with ok, false if it was unreachable.
 */
export async function sendHeartbeatToPeer(peerId: string): Promise<boolean> {
  const instanceId = await getInstanceId();

  let ok = false;
  try {
    const res = await meshFetch(peerId, "/api/v1/mesh/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId }),
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
