import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { decodeInviteToken } from "@/lib/mesh/invite";
import { generateMeshToken } from "@/lib/mesh/auth";
import { ensureHubConfig, HUB_IP, generateKeypairNative, buildDevWgConfig } from "@/lib/mesh";
import { isDevMode } from "@/lib/mesh/env";
import { getInstanceId } from "@/lib/constants";
import { getInstanceConfig } from "@/lib/system-settings";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { allocateIp, toCidr } from "@/lib/mesh/ip-allocator";

const joinSchema = z.object({ token: z.string().min(1, "Invite token is required") }).strict();

/**
 * POST /api/v1/admin/mesh/join — join a mesh using an invite token.
 *
 * This runs on the *joining* instance. It decodes the token to get the
 * hub URL + code, generates a keypair (via docker in container mode, natively
 * in dev mode), generates a token for the hub to call us, then calls the hub's
 * public join endpoint with this instance's details.
 *
 * In dev mode (pnpm dev, no WireGuard container), the response includes a
 * `wgConfig` field containing a ready-to-use vardo0.conf the developer can
 * activate with wg-quick.
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

    const dev = isDevMode();

    // Bootstrap WireGuard — docker exec in container mode, pure Node.js in dev
    let localPublicKey: string;
    let localPrivateKey: string | null = null;

    if (dev) {
      const keypair = generateKeypairNative();
      localPublicKey = keypair.publicKey;
      localPrivateKey = keypair.privateKey;
    } else {
      localPublicKey = await ensureHubConfig(HUB_IP);
    }

    const instanceId = await getInstanceId();
    const instanceConfig = await getInstanceConfig();
    const hostname = process.env.HOSTNAME || instanceConfig.domain || "unknown";

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
        type: dev ? "dev" : "persistent",
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
      tokenHash: ourTokenHash,
      outboundToken: joinData.token,
      status: "online",
      lastSeenAt: new Date(),
    });

    // In dev mode, build a vardo0.conf the developer can activate with wg-quick
    let wgConfig: string | null = null;
    if (dev && localPrivateKey) {
      if (joinData.hub.endpoint) {
        wgConfig = buildDevWgConfig(localPrivateKey, joinData.peer.internalIp, {
          publicKey: joinData.hub.publicKey,
          endpoint: joinData.hub.endpoint,
        });
      }
    }

    return NextResponse.json({
      peer: joinData.peer,
      hub: joinData.hub,
      ...(wgConfig !== null ? { wgConfig } : {}),
    });
  } catch (error) {
    return handleRouteError(error, "Error joining mesh");
  }
}
