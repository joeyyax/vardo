import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq, ne } from "drizzle-orm";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { getHubAddress } from "@/lib/mesh";
import { getInstanceId } from "@/lib/constants";
import { getInstanceConfig } from "@/lib/system-settings";

/**
 * POST /api/v1/mesh/heartbeat — peer health check.
 *
 * Authenticated via mesh bearer token. Marks the calling peer as online in the
 * local DB. Returns the full peer manifest so the caller can see all mesh members,
 * not just its direct connections.
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

    // Return the full peer list so the caller can see all mesh members.
    // Exclude the calling peer itself and strip sensitive fields.
    // instanceId and publicKey are included so the receiver can upsert
    // visible peers into its own DB without ambiguity.
    const allPeers = await db.query.meshPeers.findMany({
      where: ne(meshPeers.id, peer.id),
      columns: {
        id: true,
        instanceId: true,
        name: true,
        type: true,
        status: true,
        internalIp: true,
        allowedIps: true,
        publicKey: true,
        endpoint: true,
        lastSeenAt: true,
      },
    });

    const instanceId = await getInstanceId();
    const [config, internalIp] = await Promise.all([
      getInstanceConfig(),
      getHubAddress(),
    ]);

    return NextResponse.json({
      ok: true,
      instance: {
        id: instanceId,
        name: config.instanceName,
        internalIp,
      },
      peers: allPeers,
    });
  } catch (error) {
    return handleRouteError(error, "Error processing heartbeat");
  }
}
