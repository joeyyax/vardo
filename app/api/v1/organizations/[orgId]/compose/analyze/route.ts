import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { analyzeRawCompose } from "@/lib/docker/compose-analyze";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const analyzeSchema = z.object({
  composeContent: z.string().min(1).max(512000),
  routedServices: z.array(z.string()).optional(),
  managedEnvKeys: z.array(z.string()).optional(),
});

// POST /api/v1/organizations/[orgId]/compose/analyze
//
// Analyze a compose file and return structured findings about what Vardo
// will normalize during deploy. Used by the import-time review dialog.
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    await verifyOrgAccess(orgId);

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
