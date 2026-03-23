import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { buildProjectBundle } from "@/lib/mesh/transfers";
import { meshJsonFetch } from "@/lib/mesh/client";

const promoteSchema = z.object({
  projectId: z.string().min(1),
  targetPeerId: z.string().min(1),
  environment: z.enum(["production", "staging", "development"]),
  orgId: z.string().min(1),
  includeEnvVars: z.boolean().default(false),
});

/**
 * POST /api/v1/admin/mesh/promote — promote a project to a target instance.
 *
 * Orchestration endpoint called by the admin UI. Builds a project bundle
 * locally, then POSTs it to the target peer's /api/v1/mesh/promote endpoint.
 */
export async function POST(request: NextRequest) {
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

    const { projectId, targetPeerId, environment, orgId, includeEnvVars } = parsed.data;

    // Build the project bundle from local data
    const bundle = await buildProjectBundle(projectId, {
      transferType: "promote",
      includeEnvVars,
    });

    // Send to the target peer
    const result = await meshJsonFetch(targetPeerId, "/api/v1/mesh/promote", {
      method: "POST",
      body: JSON.stringify({ bundle, environment, orgId }),
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error promoting project");
  }
}
