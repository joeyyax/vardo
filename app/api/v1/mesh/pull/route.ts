import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { peerOrganizationId, requireMeshPeer } from "@/lib/mesh/auth";
import { buildProjectBundle } from "@/lib/mesh/transfers";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const pullSchema = z.object({
  projectId: z.string().min(1),
  includeEnvVars: z.boolean().default(false),
}).strict();

/** POST /api/v1/mesh/pull — return a project bundle to the requesting peer. */
async function handlePost(request: NextRequest) {
  try {
    const organizationId = peerOrganizationId(await requireMeshPeer(request));

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    const body = await request.json();
    const parsed = pullSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const bundle = await buildProjectBundle(parsed.data.projectId, {
      transferType: "pull",
      includeEnvVars: parsed.data.includeEnvVars,
      organizationId,
    });

    return NextResponse.json({ bundle });
  } catch (error) {
    return handleRouteError(error, "Error building pull bundle");
  }
}

export const POST = withRateLimit(handlePost, { tier: "public", key: "mesh-pull" });
