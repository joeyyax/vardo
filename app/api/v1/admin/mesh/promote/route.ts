import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { buildProjectBundle } from "@/lib/mesh/transfers";
import { MeshClientError, meshJsonFetch } from "@/lib/mesh/client";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const promoteSchema = z.object({
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  targetPeerId: z.string().min(1),
  environment: z.enum(["production", "staging", "development"]),
  includeEnvVars: z.boolean().default(false),
}).strict();

/** POST /api/v1/admin/mesh/promote — builds a project bundle and sends it to the target peer. */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = promoteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { projectId, orgId, targetPeerId, environment, includeEnvVars } = parsed.data;

    const bundle = await buildProjectBundle(projectId, {
      transferType: "promote",
      organizationId: orgId,
      includeEnvVars,
    });

    const result = await meshJsonFetch(
      targetPeerId,
      "/api/v1/mesh/promote",
      { method: "POST", body: JSON.stringify({ bundle, environment }) },
      { requireTls: includeEnvVars },
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof MeshClientError && error.code === "INSECURE") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return handleRouteError(error, "Error promoting project");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "mesh-promote" });
