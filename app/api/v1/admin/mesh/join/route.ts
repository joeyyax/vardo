import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { decodeInviteToken } from "@/lib/mesh/invite";
import { ensureHubConfig, HUB_IP } from "@/lib/mesh";
import { getInstanceId } from "@/lib/constants";

/**
 * POST /api/v1/admin/mesh/join — join a mesh using an invite token.
 *
 * This runs on the *joining* instance. It decodes the token to get the
 * hub URL + code, bootstraps local WireGuard, then calls the hub's
 * public join endpoint with this instance's details.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const { token } = await request.json();
    if (!token || typeof token !== "string") {
      return NextResponse.json(
        { error: "Invite token is required" },
        { status: 400 }
      );
    }

    const decoded = decodeInviteToken(token.trim());
    if (!decoded) {
      return NextResponse.json(
        { error: "Invalid invite token" },
        { status: 400 }
      );
    }

    // Bootstrap local WireGuard (generates keypair if needed)
    const localPublicKey = await ensureHubConfig(HUB_IP);

    const instanceId = getInstanceId();
    const hostname = process.env.HOSTNAME || process.env.VARDO_DOMAIN || "unknown";

    // Call the hub's join endpoint
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
      }),
    });

    const joinData = await joinRes.json();
    if (!joinRes.ok) {
      return NextResponse.json(
        { error: joinData.error || "Hub rejected the invite" },
        { status: joinRes.status }
      );
    }

    return NextResponse.json({
      peer: joinData.peer,
      hub: joinData.hub,
    });
  } catch (error) {
    return handleRouteError(error, "Error joining mesh");
  }
}
