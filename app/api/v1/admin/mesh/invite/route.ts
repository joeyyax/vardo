import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { createInvite } from "@/lib/mesh/invite";
import { getHubPublicKey, HUB_IP } from "@/lib/mesh";

/** POST /api/v1/admin/mesh/invite — generate an invite code for a new peer */
export async function POST() {
  try {
    await requireAppAdmin();

    // Auto-resolve hub WireGuard details
    const publicKey = await getHubPublicKey();
    if (!publicKey) {
      return NextResponse.json(
        { error: "WireGuard is not running — start the mesh profile first" },
        { status: 503 }
      );
    }

    const serverIp = process.env.VARDO_SERVER_IP || process.env.VARDO_DOMAIN;
    if (!serverIp) {
      return NextResponse.json(
        { error: "VARDO_SERVER_IP or VARDO_DOMAIN must be set" },
        { status: 503 }
      );
    }

    const port = process.env.WIREGUARD_PORT || "51820";
    const endpoint = `${serverIp}:${port}`;

    const code = await createInvite({
      publicKey,
      endpoint,
      internalIp: HUB_IP,
    });

    return NextResponse.json({ code }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating mesh invite");
  }
}
