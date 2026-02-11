import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import { getRetainerStatus } from "@/lib/retainer";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
};

/**
 * GET /api/v1/organizations/[orgId]/clients/[clientId]/retainer
 * Get retainer status for a client.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const status = await getRetainerStatus(clientId);

    if (!status) {
      return NextResponse.json(
        { error: "Client does not have retainer billing" },
        { status: 404 }
      );
    }

    return NextResponse.json(status);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching retainer status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
