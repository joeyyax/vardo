import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { peerOrganizationId, requireMeshPeer } from "@/lib/mesh/auth";
import { BundleRejectedError, importProjectBundle } from "@/lib/mesh/transfers";
import { projectBundleSchema } from "@/lib/mesh/bundle-schema";
import type { ProjectBundle } from "@/lib/mesh/transfers";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const promoteSchema = z.object({
  bundle: projectBundleSchema.extend({
    transferType: z.literal("promote"),
  }),
  environment: z.enum(["production", "staging", "development"]),
  // Ignored: the target org comes from the peer's binding.
  orgId: z.string().optional(),
}).strict();

/** POST /api/v1/mesh/promote — import a peer's project bundle and deploy it. */
async function handlePost(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);
    const orgId = peerOrganizationId(peer);

    const body = await request.json();
    const parsed = promoteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid bundle", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { bundle, environment } = parsed.data;

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
    if (error instanceof BundleRejectedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return handleRouteError(error, "Error receiving promotion");
  }
}

export const POST = withRateLimit(handlePost, { tier: "public", key: "mesh-promote" });
