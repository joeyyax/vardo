import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { peerOrganizationId, requireMeshPeer } from "@/lib/mesh/auth";
import { BundleRejectedError, importProjectBundle } from "@/lib/mesh/transfers";
import { projectBundleSchema } from "@/lib/mesh/bundle-schema";
import type { ProjectBundle } from "@/lib/mesh/transfers";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const cloneSchema = z.object({
  bundle: projectBundleSchema.extend({
    transferType: z.literal("clone"),
  }),
  // Ignored: the target org comes from the peer's binding.
  orgId: z.string().optional(),
}).strict();

/** POST /api/v1/mesh/clone — receive a bundle as a fresh clone with unique names and no env vars. */
async function handlePost(request: NextRequest) {
  try {
    const orgId = peerOrganizationId(await requireMeshPeer(request));

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    const body = await request.json();
    const parsed = cloneSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid bundle", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { bundle } = parsed.data;

    const result = await importProjectBundle(
      orgId,
      bundle as ProjectBundle,
      "development"
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BundleRejectedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return handleRouteError(error, "Error receiving clone");
  }
}

export const POST = withRateLimit(handlePost, { tier: "public", key: "mesh-clone" });
