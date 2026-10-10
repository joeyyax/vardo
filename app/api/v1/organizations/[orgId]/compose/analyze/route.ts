import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { analyzeRawCompose } from "@/lib/docker/compose-analyze";
import { z } from "zod";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const analyzeSchema = z.object({
  composeContent: z.string().min(1).max(512000),
  routedServices: z.array(z.string()).optional(),
  managedEnvKeys: z.array(z.string()).optional(),
});

// POST /api/v1/organizations/[orgId]/compose/analyze
// Lists what Vardo will normalize in a compose file during deploy.
async function handlePost(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "app.create");
    if (!org) return apiError.forbidden();

    const body = analyzeSchema.parse(await req.json());

    const analysis = analyzeRawCompose(body.composeContent, {
      routedServices: body.routedServices
        ? new Set(body.routedServices)
        : undefined,
      managedEnvKeys: body.managedEnvKeys
        ? new Set(body.managedEnvKeys)
        : undefined,
    });

    return NextResponse.json(analysis);
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "compose-analyze" });
