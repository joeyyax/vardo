import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { createInvite } from "@/lib/mesh/invite";
import { ensureHubConfig, HUB_IP } from "@/lib/mesh";
import { getInstanceConfig } from "@/lib/system-settings";

/** POST /api/v1/admin/mesh/invite — generate an invite code for a new peer */
export async function POST() {
  try {
    await requireAppAdmin();

    const config = await getInstanceConfig();
    const serverIp = config.serverIp || config.domain;
    if (!serverIp) {
      return NextResponse.json(
        { error: "Server IP or primary domain must be configured in admin settings" },
        { status: 503 }
      );
    }

    // Bootstrap WireGuard if needed (generates keypair, writes config, brings up wg0)
    const publicKey = await ensureHubConfig(HUB_IP);

    const port = process.env.WIREGUARD_PORT || "51820";
    const endpoint = `${serverIp}:${port}`;

    const domain = config.domain || serverIp;
    const protocol = domain === "localhost" ? "http" : "https";
    const apiUrl = `${protocol}://${domain}`;

    const token = await createInvite({
      publicKey,
      endpoint,
      internalIp: HUB_IP,
      apiUrl,
    });

    return NextResponse.json({ token }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating mesh invite");
  }
}
