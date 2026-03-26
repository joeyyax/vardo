import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireMeshPeer } from "@/lib/mesh/auth";

/**
 * POST /api/v1/mesh/heartbeat — peer health check.
 *
 * Authenticated via mesh bearer token. Marks the calling peer as online in the
 * local DB. The caller marks this instance online on their side when they
 * receive the 200 — that's the bidirectional liveness tracking.
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

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error processing heartbeat");
  }
}
