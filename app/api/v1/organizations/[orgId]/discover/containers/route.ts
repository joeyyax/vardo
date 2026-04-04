import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";
import { discoverContainers } from "@/lib/docker/discover";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/discover/containers
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("container-import");
    if (gate) return gate;

    const result = await discoverContainers();
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error discovering containers");
  }
}
