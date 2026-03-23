import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { createInvite } from "@/lib/mesh/invite";
import { ensureHubConfig, HUB_IP } from "@/lib/mesh";

/** POST /api/v1/admin/mesh/invite — generate an invite code for a new peer */
export async function POST() {
  try {
    await requireAppAdmin();

    const serverIp = process.env.VARDO_SERVER_IP || process.env.VARDO_DOMAIN;
    if (!serverIp) {
      return NextResponse.json(
        { error: "VARDO_SERVER_IP or VARDO_DOMAIN must be set" },
        { status: 503 }
      );
    }

    // Bootstrap WireGuard if needed (generates keypair, writes config, brings up wg0)
    const publicKey = await ensureHubConfig(HUB_IP);

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
