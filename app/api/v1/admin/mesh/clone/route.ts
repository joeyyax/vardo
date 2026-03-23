import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { importProjectBundle } from "@/lib/mesh/transfers";
import { meshJsonFetch } from "@/lib/mesh/client";
import type { ProjectBundle } from "@/lib/mesh/transfers";

const cloneSchema = z.object({
  sourcePeerId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  /** Optional: clone to a different peer instead of locally. */
  targetPeerId: z.string().optional(),
});

/**
 * POST /api/v1/admin/mesh/clone — clone a project from a source instance.
 *
 * Fetches the bundle from the source peer, then either imports locally
 * or forwards to a target peer. Clones always create fresh deployments
 * with unique names and no env vars.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = cloneSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { sourcePeerId, projectId, orgId, targetPeerId } = parsed.data;

    // Fetch the bundle from the source peer (without env vars — clone is fresh)
    const { bundle } = await meshJsonFetch<{ bundle: ProjectBundle }>(
      sourcePeerId,
      "/api/v1/mesh/pull",
      {
        method: "POST",
        body: JSON.stringify({ projectId, includeEnvVars: false }),
      }
    );

    const cloneBundle = { ...bundle, transferType: "clone" as const };

    if (targetPeerId) {
      // Clone to a different peer
      const result = await meshJsonFetch(targetPeerId, "/api/v1/mesh/clone", {
        method: "POST",
        body: JSON.stringify({ bundle: cloneBundle, orgId }),
      });
      return NextResponse.json(result, { status: 201 });
    }

    // Clone locally
    const result = await importProjectBundle(orgId, cloneBundle, "development");
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error cloning project");
  }
}
