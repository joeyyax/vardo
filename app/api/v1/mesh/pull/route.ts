import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { buildProjectBundle } from "@/lib/mesh/transfers";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const pullSchema = z.object({
  projectId: z.string().min(1),
  includeEnvVars: z.boolean().default(false),
}).strict();

/**
 * POST /api/v1/mesh/pull — return a project bundle to the requesting peer.
 *
 * Called by a peer instance over WireGuard. The requesting instance wants
 * to pull this project for local development/testing. This endpoint builds
 * the bundle and returns it.
 */
async function handlePost(request: NextRequest) {
  try {
    await requireMeshPeer(request);

    const body = await request.json();
    const parsed = pullSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    // Any authenticated peer can pull any project — mesh peers are system-level
    // and carry no org grants, so there is nothing to scope against.
    const bundle = await buildProjectBundle(parsed.data.projectId, {
      transferType: "pull",
      includeEnvVars: parsed.data.includeEnvVars,
    });

    return NextResponse.json({ bundle });
  } catch (error) {
    return handleRouteError(error, "Error building pull bundle");
  }
}

export const POST = withRateLimit(handlePost, { tier: "public", key: "mesh-pull" });
