import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { registerPeer } from "@/lib/mesh/peers";

const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const addPeerSchema = z.object({
  instanceId: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["persistent", "dev"]).default("persistent"),
  publicKey: z.string().regex(WG_KEY_RE, "Invalid WireGuard public key"),
  endpoint: z.string().nullable().optional(),
});

/** GET /api/v1/admin/mesh/peers — list all mesh peers */
export async function GET() {
  try {
    await requireAppAdmin();

    const peers = await db.query.meshPeers.findMany({
      columns: {
        tokenHash: false,
      },
    });

    return NextResponse.json({ peers });
  } catch (error) {
    return handleRouteError(error, "Error listing mesh peers");
  }
}

/** POST /api/v1/admin/mesh/peers — register a new peer */
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = addPeerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Check for duplicate instanceId
    const existing = await db.query.meshPeers.findFirst({
      where: eq(meshPeers.instanceId, parsed.data.instanceId),
    });
    if (existing) {
      return NextResponse.json(
        { error: "Instance already registered" },
        { status: 409 }
      );
    }

    const { peer, token } = await registerPeer(parsed.data);

    const { tokenHash: _hash, ...peerWithoutHash } = peer;
    return NextResponse.json({ peer: peerWithoutHash, token }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error registering mesh peer");
  }
}
