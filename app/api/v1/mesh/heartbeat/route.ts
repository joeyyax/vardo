import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq, ne } from "drizzle-orm";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { getHubAddress } from "@/lib/mesh";
import { getInstanceId } from "@/lib/constants";
import { getInstanceConfig } from "@/lib/system-settings";
import { localVardoStatus, parseVardoStatus, vardoStatusColumns } from "@/lib/self-update/peer-status";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

/** POST /api/v1/mesh/heartbeat — marks the calling peer online and returns the full peer manifest. */
async function handlePost(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    const sent = (await request.json().catch(() => null)) as { vardo?: unknown } | null;
    await db
      .update(meshPeers)
      .set({
        status: "online",
        lastSeenAt: new Date(),
        updatedAt: new Date(),
        ...vardoStatusColumns(parseVardoStatus(sent?.vardo)),
      })
      .where(eq(meshPeers.id, peer.id));

    // Every peer except the caller, without sensitive fields.
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
        vardo: localVardoStatus(),
      },
      peers: allPeers,
    });
  } catch (error) {
    return handleRouteError(error, "Error processing heartbeat");
  }
}

export const POST = withRateLimit(handlePost, { tier: "public", key: "mesh-heartbeat" });
