import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { buildShareableConfig } from "@/lib/mesh/shareable-config";

/**
 * GET /api/v1/mesh/config — credential-free config for authenticated peers.
 * Reachable on the public origin: add nothing you wouldn't hand any peer-token holder.
 */
export async function GET(request: NextRequest) {
  try {
    await requireMeshPeer(request);

    return NextResponse.json(await buildShareableConfig());
  } catch (error) {
    return handleRouteError(error, "Error fetching mesh config");
  }
}
