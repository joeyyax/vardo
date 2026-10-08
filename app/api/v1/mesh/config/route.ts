import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { buildShareableConfig } from "@/lib/mesh/shareable-config";
import { requirePlugin } from "@/lib/api/require-plugin";

/**
 * GET /api/v1/mesh/config — credential-free config for authenticated peers.
 * Reachable on the public origin: add nothing you wouldn't hand any peer-token holder.
 */
async function handleGet(request: NextRequest) {
  try {
    await requireMeshPeer(request);

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    return NextResponse.json(await buildShareableConfig());
  } catch (error) {
    return handleRouteError(error, "Error fetching mesh config");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/mesh/config" });
