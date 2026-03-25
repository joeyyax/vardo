import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { z } from "zod";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redeemInvite } from "@/lib/mesh/invite";
import { registerPeer } from "@/lib/mesh/peers";

const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const joinSchema = z.object({
  code: z.string().min(1, "Invite code is required"),
  instanceId: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["persistent", "dev"]).default("dev"),
  publicKey: z.string().regex(WG_KEY_RE, "Invalid WireGuard public key"),
  endpoint: z.string().nullable().optional(),
  /** Token the joining instance provides for the hub to call its API. */
  outboundToken: z.string().optional(),
}).strict();

/**
 * POST /api/v1/mesh/join — join the mesh using an invite code.
 *
 * No session auth — the invite code is the credential.
 * Rate limited: 5 attempts per minute per IP.
 */
async function handler(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { code, outboundToken: joinerOutboundToken, ...peerInput } = parsed.data;

    // Redeem the invite — atomic, one-time use
    const hub = await redeemInvite(code);
    if (!hub) {
      return NextResponse.json(
        { error: "Invalid or expired invite code" },
        { status: 401 }
      );
    }

    const { peer, token } = await registerPeer(peerInput);

    // Store the joiner's outbound token so we can call their API
    if (joinerOutboundToken) {
      await db
        .update(meshPeers)
        .set({ outboundToken: joinerOutboundToken })
        .where(eq(meshPeers.id, peer.id));
    }

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

export const POST = withRateLimit(handler, { tier: "auth", key: "mesh-join" });
