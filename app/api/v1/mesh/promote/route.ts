import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { importProjectBundle } from "@/lib/mesh/transfers";
import { projectBundleSchema } from "@/lib/mesh/bundle-schema";
import type { ProjectBundle } from "@/lib/mesh/transfers";

const promoteSchema = z.object({
  bundle: projectBundleSchema.extend({
    transferType: z.literal("promote"),
  }),
  environment: z.enum(["production", "staging", "development"]),
  orgId: z.string().min(1),
});

/**
 * POST /api/v1/mesh/promote — receive a project bundle and deploy it.
 *
 * Called by a peer instance over WireGuard. The source instance builds
 * the bundle and POSTs it here. This endpoint imports the bundle and
 * creates/updates the project on this instance.
 */
export async function POST(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);

    const body = await request.json();
    const parsed = promoteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid bundle", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { bundle, environment, orgId } = parsed.data;

    // Enforce instance type rules: dev instances can only promote to staging
    if (peer.type === "dev" && environment !== "staging") {
      return NextResponse.json(
        { error: "Dev instances can only promote to staging" },
        { status: 403 }
      );
    }

    const result = await importProjectBundle(
      orgId,
      bundle as ProjectBundle,
      environment
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error receiving promotion");
  }
}
