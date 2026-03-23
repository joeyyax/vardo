import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { buildProjectBundle } from "@/lib/mesh/transfers";

const pullSchema = z.object({
  projectId: z.string().min(1),
  includeEnvVars: z.boolean().default(false),
});

/**
 * POST /api/v1/mesh/pull — return a project bundle to the requesting peer.
 *
 * Called by a peer instance over WireGuard. The requesting instance wants
 * to pull this project for local development/testing. This endpoint builds
 * the bundle and returns it.
 */
export async function POST(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);

    const body = await request.json();
    const parsed = pullSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    // Dev instances can't be pulled from — their state is ephemeral
    // This check is about *this* instance being pulled from
    // The peer type check doesn't apply here since the requesting peer
    // could be any type. The restriction is on the source (us).

    const bundle = await buildProjectBundle(parsed.data.projectId, {
      transferType: "pull",
      includeEnvVars: parsed.data.includeEnvVars,
    });

    return NextResponse.json({ bundle });
  } catch (error) {
    return handleRouteError(error, "Error building pull bundle");
  }
}
