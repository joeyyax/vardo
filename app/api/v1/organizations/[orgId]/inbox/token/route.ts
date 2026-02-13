import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import { getOrCreateIntakeToken } from "@/lib/intake-email";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// POST /api/v1/organizations/[orgId]/inbox/token
// Get or create the intake email address for the org
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Only owners and admins can generate the intake email
    if (membership.role !== "owner" && membership.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await getOrCreateIntakeToken(orgId);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error generating intake token:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
