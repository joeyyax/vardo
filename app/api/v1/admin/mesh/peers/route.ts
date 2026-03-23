import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { allocateIp, toCidr } from "@/lib/mesh";
import { generateMeshToken } from "@/lib/mesh/auth";

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

    const { instanceId, name, type, publicKey, endpoint } = parsed.data;

    // Check for duplicate instanceId or publicKey
    const existing = await db.query.meshPeers.findFirst({
      where: eq(meshPeers.instanceId, instanceId),
    });
    if (existing) {
      return NextResponse.json(
        { error: "Instance already registered" },
        { status: 409 }
      );
    }

    // Allocate a tunnel IP
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

    // Return the peer info + raw token (only time it's visible)
    const { tokenHash: _hash, ...peerWithoutHash } = peer;
    return NextResponse.json({ peer: peerWithoutHash, token }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error registering mesh peer");
  }
}
