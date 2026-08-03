import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { buildShareableConfig } from "@/lib/mesh/shareable-config";

/**
 * GET /api/v1/mesh/config — return credential-free config to authenticated mesh peers.
 *
 * Used during onboarding so a new instance can inherit config shape from an existing
 * one. Secrets are never served: a peer's admin supplies its own credentials.
 * Authenticated via mesh bearer token, and reachable on the public origin — add
 * nothing here that you would not hand to any instance holding a peer token.
 */
export async function GET(request: NextRequest) {
  try {
    await requireMeshPeer(request);

    return NextResponse.json(await buildShareableConfig());
  } catch (error) {
    return handleRouteError(error, "Error fetching mesh config");
  }
}
