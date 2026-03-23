import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { z } from "zod";
import { redeemInvite } from "@/lib/mesh/invite";
import { allocateIp, toCidr } from "@/lib/mesh";
import { generateMeshToken } from "@/lib/mesh/auth";

const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const joinSchema = z.object({
  code: z.string().min(1, "Invite code is required"),
  instanceId: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["persistent", "dev"]).default("dev"),
  publicKey: z.string().regex(WG_KEY_RE, "Invalid WireGuard public key"),
  endpoint: z.string().nullable().optional(),
});

/**
 * POST /api/v1/mesh/join — join the mesh using an invite code.
 *
 * No session auth required — the invite code is the credential.
 * Called by the joining instance during the pairing flow.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { code, instanceId, name, type, publicKey, endpoint } = parsed.data;

    // Redeem the invite — one-time use, validates expiry
    const hub = await redeemInvite(code);
    if (!hub) {
      return NextResponse.json(
        { error: "Invalid or expired invite code" },
        { status: 401 }
      );
    }

    // Allocate a tunnel IP for the new peer
    const allPeers = await db.query.meshPeers.findMany({
      columns: { internalIp: true },
    });
    const internalIp = allocateIp(allPeers.map((p) => p.internalIp));

    // Generate a service-to-service token
    const { raw: token, hash: tokenHash } = generateMeshToken();

    const peer = {
      id: nanoid(),
      instanceId,
      name,
      type: type as "persistent" | "dev",
      publicKey,
      endpoint: endpoint ?? null,
      allowedIps: toCidr(internalIp),
      internalIp,
      apiUrl: `http://${internalIp}:3000`,
      tokenHash,
      status: "offline" as const,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(meshPeers).values(peer);

    // Return everything the joining peer needs to configure WireGuard
    const { tokenHash: _hash, ...peerWithoutHash } = peer;
    return NextResponse.json(
      {
        peer: peerWithoutHash,
        token,
        hub: {
          publicKey: hub.hubPublicKey,
          endpoint: hub.hubEndpoint,
          internalIp: hub.hubInternalIp,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return handleRouteError(error, "Error joining mesh");
  }
}
