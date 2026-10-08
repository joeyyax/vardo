import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { BundleRejectedError, importProjectBundle } from "@/lib/mesh/transfers";
import { MeshClientError, meshJsonFetch } from "@/lib/mesh/client";
import type { ProjectBundle } from "@/lib/mesh/transfers";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const pullSchema = z.object({
  sourcePeerId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  environment: z.enum(["production", "staging", "development"]).default("development"),
  includeEnvVars: z.boolean().default(false),
}).strict();

/** POST /api/v1/admin/mesh/pull — fetches a bundle from the source peer and imports it. */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    const body = await request.json();
    const parsed = pullSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const { sourcePeerId, projectId, orgId, environment, includeEnvVars } = parsed.data;

    const { bundle } = await meshJsonFetch<{ bundle: ProjectBundle }>(
      sourcePeerId,
      "/api/v1/mesh/pull",
      {
        method: "POST",
        body: JSON.stringify({ projectId, includeEnvVars }),
      },
      { requireTls: includeEnvVars },
    );

    const result = await importProjectBundle(orgId, bundle, environment);

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (
      error instanceof BundleRejectedError ||
      (error instanceof MeshClientError && error.code === "INSECURE")
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return handleRouteError(error, "Error pulling project");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "mesh-pull" });
