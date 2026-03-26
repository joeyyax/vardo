import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { getInstanceId } from "@/lib/constants";

/**
 * POST /api/v1/mesh/heartbeat — peer health check.
 *
 * Authenticated via mesh bearer token. Marks the calling peer as online and
 * returns this instance's ID so the caller can update the peer's status on
 * their side too, enabling bidirectional liveness tracking without requiring
 * each side to independently schedule outbound heartbeats.
 *
 * Request body (optional):
 *   { instanceId: string }  — sender's instance ID for log correlation
 */
export async function POST(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);

    await db
      .update(meshPeers)
      .set({
        status: "online",
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(meshPeers.id, peer.id));

    const instanceId = await getInstanceId();

    return NextResponse.json({ ok: true, instanceId });
  } catch (error) {
    return handleRouteError(error, "Error processing heartbeat");
  }
}
