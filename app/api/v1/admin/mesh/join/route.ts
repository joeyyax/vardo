import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { decodeInviteToken } from "@/lib/mesh/invite";
import { generateMeshToken } from "@/lib/mesh/auth";
import { ensureHubConfig } from "@/lib/mesh";
import { getInstanceId } from "@/lib/constants";
import { getInstanceConfig } from "@/lib/system-settings";
import { needsSetup } from "@/lib/setup";
import { inheritConfigFromHub, validateHubUrl } from "@/lib/mesh/config-inheritance";
import { rebuildAndSync } from "@/lib/mesh/wireguard";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { toCidr } from "@/lib/mesh/ip-allocator";

const joinSchema = z.object({ token: z.string().min(1, "Invite token is required") }).strict();

/**
 * POST /api/v1/admin/mesh/join — join a mesh using an invite token.
 *
 * This runs on the *joining* instance. It decodes the token to get the
 * hub URL + code, bootstraps local WireGuard, generates a token for the
 * hub to call us, then calls the hub's public join endpoint with this
 * instance's details.
 *
 * During initial setup (no users exist), auth is bypassed so the join
 * can happen before account creation.
 */
export async function POST(request: NextRequest) {
  try {
    const isSetup = await needsSetup();
    if (!isSetup) {
      await requireAppAdmin();
    }

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
        { error: "Invalid or expired invite token. Generate a new one on the other instance." },
        { status: 400 }
      );
    }

    const urlCheck = validateHubUrl(decoded.hubApiUrl);
    if (!urlCheck.valid) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }

    // Bootstrap local WireGuard with a temporary address (just to get the keypair).
    // The correct address will be set by rebuildAndSync after the hub assigns our IP.
    const localPublicKey = await ensureHubConfig("10.99.0.254");

    const instanceId = await getInstanceId();
    const instanceConfig = await getInstanceConfig();
    const hostname = instanceConfig.instanceName || instanceConfig.domain || "unknown";

    // Generate a token the hub can use to call our API
    const { raw: ourToken, hash: ourTokenHash } = generateMeshToken();

    // Call the hub's join endpoint
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
        { error: "Could not reach the other instance. Check that it's online and accessible." },
        { status: 502 }
      );
    }

    const joinData = await joinRes.json();
    if (!joinRes.ok) {
      return NextResponse.json(
        { error: joinData.error || "The other instance rejected the invite." },
        { status: joinRes.status }
      );
    }

    // The hub allocated an IP for us: joinData.peer.internalIp
    // The hub's own mesh IP: joinData.hub.internalIp
    // The hub's WireGuard endpoint: joinData.hub.endpoint (IP:port for UDP)
    const ourMeshIp = joinData.peer.internalIp;

    // Register the hub as a peer on our side
    await db.insert(meshPeers).values({
      id: nanoid(),
      instanceId: joinData.peer.instanceId,
      name: "Hub",
      type: "persistent",
      publicKey: joinData.hub.publicKey,
      endpoint: joinData.hub.endpoint,
      allowedIps: toCidr(joinData.hub.internalIp),
      internalIp: joinData.hub.internalIp,
      apiUrl: `http://${joinData.hub.internalIp}:3000`,
      publicApiUrl: decoded.hubApiUrl,
      tokenHash: ourTokenHash,
      outboundToken: joinData.token,
      status: "online",
      lastSeenAt: new Date(),
    });

    // Rebuild WireGuard config with the hub as a peer and our correct mesh IP
    try {
      const { isWireguardRunning } = await import("@/lib/mesh/wireguard");
      if (await isWireguardRunning()) {
        await rebuildAndSync(ourMeshIp);
      }
    } catch (err) {
      console.warn(`[mesh] WireGuard sync failed after joining hub: ${err}`);
    }

    // Pull shareable config from the hub (best-effort)
    let inheritedConfig = { email: false, backup: false, github: false };
    try {
      inheritedConfig = await inheritConfigFromHub(decoded.hubApiUrl, joinData.token);
    } catch {
      // Config inheritance is best-effort — don't fail the join
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
