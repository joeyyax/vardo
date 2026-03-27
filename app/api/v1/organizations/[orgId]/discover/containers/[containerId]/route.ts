import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { getContainerDetail } from "@/lib/docker/discover";

type RouteParams = {
  params: Promise<{ orgId: string; containerId: string }>;
};

// GET /api/v1/organizations/[orgId]/discover/containers/[containerId]
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { orgId, containerId } = await params;

    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      return NextResponse.json({ error: "Invalid container ID" }, { status: 400 });
    }

    const detail = await getContainerDetail(containerId);
    if (!detail) {
      return NextResponse.json(
        { error: "Container not found or is Vardo-managed" },
        { status: 404 }
      );
    }

    return NextResponse.json(detail);
  } catch (error) {
    return handleRouteError(error, "Error inspecting container");
  }
}
