import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/members
// Returns all members of the organization
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const orgMemberships = await db.query.memberships.findMany({
      where: eq(memberships.organizationId, orgId),
      with: {
        user: {
          columns: { id: true, name: true, email: true },
        },
      },
    });

    const members = orgMemberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
    }));

    return NextResponse.json({ members });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching members:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
