import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { decodeInviteToken } from "@/lib/mesh/invite";
import { generateMeshToken } from "@/lib/mesh/auth";
import { ensureHubConfig, HUB_IP } from "@/lib/mesh";
import { getInstanceId } from "@/lib/constants";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { allocateIp, toCidr } from "@/lib/mesh/ip-allocator";

const joinSchema = z.object({ token: z.string().min(1, "Invite token is required") }).strict();

/**
 * POST /api/v1/admin/mesh/join — join a mesh using an invite token.
 *
 * This runs on the *joining* instance. It decodes the token to get the
 * hub URL + code, bootstraps local WireGuard, generates a token for the
 * hub to call us, then calls the hub's public join endpoint with this
 * instance's details.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const decoded = decodeInviteToken(parsed.data.token.trim());
    if (!decoded) {
      return NextResponse.json(
        { error: "Invalid invite token" },
        { status: 400 }
      );
    }

    // Bootstrap local WireGuard (generates keypair if needed)
    const localPublicKey = await ensureHubConfig(HUB_IP);

    const instanceId = await getInstanceId();
    const hostname = process.env.HOSTNAME || process.env.VARDO_DOMAIN || "unknown";

    // Generate a token the hub can use to call our API
    const { raw: ourToken, hash: ourTokenHash } = generateMeshToken();

    // Call the hub's join endpoint — include our token so the hub can call us back
    const joinRes = await fetch(`${decoded.hubApiUrl}/api/v1/mesh/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: decoded.code,
        instanceId,
        name: hostname,
        type: "persistent",
        publicKey: localPublicKey,
        endpoint: null,
        outboundToken: ourToken,
      }),
    });

    const joinData = await joinRes.json();
    if (!joinRes.ok) {
      return NextResponse.json(
        { error: joinData.error || "Hub rejected the invite" },
        { status: joinRes.status }
      );
    }

    // Register the hub as a peer on our side so we can call its API
    const allPeers = await db.query.meshPeers.findMany({
      columns: { internalIp: true },
    });
    const internalIp = allocateIp(allPeers.map((p) => p.internalIp));

    await db.insert(meshPeers).values({
      id: nanoid(),
      instanceId: joinData.peer.instanceId,
      name: "Hub",
      type: "persistent",
      publicKey: joinData.hub.publicKey,
      endpoint: joinData.hub.endpoint,
      allowedIps: toCidr(joinData.hub.internalIp),
      internalIp,
      apiUrl: decoded.hubApiUrl,
      tokenHash: ourTokenHash, // hash of the token we gave them (for inbound auth if they call us)
      outboundToken: joinData.token, // token the hub gave us (for calling the hub's API)
      status: "online",
      lastSeenAt: new Date(),
    });

    return NextResponse.json({
      peer: joinData.peer,
      hub: joinData.hub,
    });
  } catch (error) {
    return handleRouteError(error, "Error joining mesh");
  }
}
