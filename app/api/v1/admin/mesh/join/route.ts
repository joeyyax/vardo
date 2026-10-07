import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { decodeInviteToken } from "@/lib/mesh/invite";
import { generateMeshToken } from "@/lib/mesh/auth";
import { ensureHubConfig } from "@/lib/mesh";
import { getInstanceId } from "@/lib/constants";
import { getInstanceDisplayName } from "@/lib/system-settings";
import { hostname as osHostname } from "node:os";
import { needsSetup } from "@/lib/setup";
import { inheritConfigFromHub, validateHubUrl, EMPTY_INHERITED_CONFIG } from "@/lib/mesh/config-inheritance";
import { rebuildAndSync } from "@/lib/mesh/wireguard";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { toCidr } from "@/lib/mesh/ip-allocator";
import { sealOutboundToken } from "@/lib/mesh/outbound-token";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const joinSchema = z.object({ token: z.string().min(1, "Invite token is required") }).strict();

const joinResponseSchema = z.object({
  peer: z.object({
    instanceId: z.string(),
    internalIp: z.string(),
  }).passthrough(),
  token: z.string(),
  hub: z.object({
    /** Absent from older hubs. */
    instanceId: z.string().min(1).max(128).optional(),
    publicKey: z.string(),
    endpoint: z.string().nullable().optional(),
    internalIp: z.string(),
    name: z.string().max(255).nullable().optional(),
  }),
});

/**
 * POST /api/v1/admin/mesh/join — runs on the joining instance and calls the hub's join endpoint.
 * Skips auth during initial setup so the join can precede account creation.
 */
async function handlePost(request: NextRequest) {
  try {
    const isSetup = await needsSetup();
    if (!isSetup) {
      await requireAppAdmin();
    }

    const body = await request.json();
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const decoded = decodeInviteToken(parsed.data.token.trim());
    if (!decoded) {
      return NextResponse.json(
        { error: "Invalid or expired invite token. Generate a new one on the other instance." },
        { status: 400 }
      );
    }

    const urlCheck = validateHubUrl(decoded.hubApiUrl);
    if (!urlCheck.valid) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }

    // Temporary address for the keypair. rebuildAndSync sets the one the hub assigns.
    const localPublicKey = await ensureHubConfig("10.99.0.254");

    const instanceId = await getInstanceId();
    const hostname = (await getInstanceDisplayName()) ?? osHostname();

    // Token the hub uses to call this instance.
    const { raw: ourToken, hash: ourTokenHash } = generateMeshToken();

    let joinRes: Response;
    try {
      joinRes = await fetch(`${decoded.hubApiUrl}/api/v1/mesh/join`, {
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
    } catch {
      return NextResponse.json(
        { error: "Couldn't reach the other instance. Check that it's online and accessible." },
        { status: 502 }
      );
    }

    const rawJoinData = await joinRes.json();
    if (!joinRes.ok) {
      return NextResponse.json(
        { error: rawJoinData.error || "The other instance rejected the invite." },
        { status: joinRes.status }
      );
    }

    // Clamps hub.name to 255 chars.
    const joinParsed = joinResponseSchema.safeParse(rawJoinData);
    if (!joinParsed.success) {
      return NextResponse.json(
        { error: "Unexpected response from the other instance." },
        { status: 502 }
      );
    }
    const joinData = joinParsed.data;

    const ourMeshIp = joinData.peer.internalIp;

    // instanceId identifies the hub. A self-id collides the next time this instance pairs.
    await db.insert(meshPeers).values({
      id: nanoid(),
      instanceId: joinData.hub.instanceId ?? `hub:${joinData.hub.publicKey}`,
      name: joinData.hub.name || "Hub",
      type: "persistent",
      publicKey: joinData.hub.publicKey,
      endpoint: joinData.hub.endpoint,
      allowedIps: toCidr(joinData.hub.internalIp),
      internalIp: joinData.hub.internalIp,
      apiUrl: `http://${joinData.hub.internalIp}:3000`,
      publicApiUrl: decoded.hubApiUrl,
      tokenHash: ourTokenHash,
      outboundToken: sealOutboundToken(joinData.token),
      status: "online",
      lastSeenAt: new Date(),
    });

    // Rebuild WireGuard with the hub as a peer and the assigned mesh IP.
    try {
      const { isWireguardRunning } = await import("@/lib/mesh/wireguard");
      if (await isWireguardRunning()) {
        await rebuildAndSync(ourMeshIp);
      }
    } catch (err) {
      console.warn(`[mesh] WireGuard sync failed after joining hub: ${err}`);
    }

    // Pull shareable config from the hub (best-effort)
    let inheritedConfig = EMPTY_INHERITED_CONFIG;
    try {
      inheritedConfig = await inheritConfigFromHub(decoded.hubApiUrl, joinData.token);
    } catch {
    }

    return NextResponse.json({
      peer: joinData.peer,
      hub: joinData.hub,
      inheritedConfig,
    });
  } catch (error) {
    return handleRouteError(error, "Error joining mesh");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "mesh-join" });
