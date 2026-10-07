import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { z } from "zod";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redeemInvite } from "@/lib/mesh/invite";
import { registerPeer } from "@/lib/mesh/peers";
import { getInstanceDisplayName } from "@/lib/system-settings";
import { getInstanceId } from "@/lib/constants";
import { sealOutboundToken } from "@/lib/mesh/outbound-token";

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

/** POST /api/v1/mesh/join — the invite code is the credential. Rate limited to 5/min per IP. */
async function handler(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
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

    const [{ peer, token }, hubName, hubInstanceId] = await Promise.all([
      registerPeer(peerInput),
      getInstanceDisplayName(),
      getInstanceId(),
    ]);

    // The joiner's token for calling its API.
    if (joinerOutboundToken) {
      await db
        .update(meshPeers)
        .set({ outboundToken: sealOutboundToken(joinerOutboundToken) })
        .where(eq(meshPeers.id, peer.id));
    }

    const { tokenHash: _hash, ...peerWithoutHash } = peer;
    return NextResponse.json(
      {
        peer: peerWithoutHash,
        token,
        hub: {
          instanceId: hubInstanceId,
          publicKey: hub.hubPublicKey,
          endpoint: hub.hubEndpoint,
          internalIp: hub.hubInternalIp,
          name: hubName,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return handleRouteError(error, "Error joining mesh");
  }
}

export const POST = withRateLimit(handler, { tier: "auth", key: "mesh-join" });
