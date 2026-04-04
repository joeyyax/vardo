import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { importProjectBundle } from "@/lib/mesh/transfers";
import { meshJsonFetch } from "@/lib/mesh/client";
import type { ProjectBundle } from "@/lib/mesh/transfers";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const pullSchema = z.object({
  sourcePeerId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  environment: z.enum(["production", "staging", "development"]).default("development"),
  includeEnvVars: z.boolean().default(false),
}).strict();

/**
 * POST /api/v1/admin/mesh/pull — pull a project from a source instance.
 *
 * Orchestration endpoint called by the admin UI. Calls the source peer's
 * /api/v1/mesh/pull endpoint to get the bundle, then imports it locally.
 */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = pullSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { sourcePeerId, projectId, orgId, environment, includeEnvVars } = parsed.data;

    // Fetch the bundle from the source peer
    const { bundle } = await meshJsonFetch<{ bundle: ProjectBundle }>(
      sourcePeerId,
      "/api/v1/mesh/pull",
      {
        method: "POST",
        body: JSON.stringify({ projectId, includeEnvVars }),
      }
    );

    // Import locally
    const result = await importProjectBundle(orgId, bundle, environment);

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error pulling project");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "mesh-pull" });
