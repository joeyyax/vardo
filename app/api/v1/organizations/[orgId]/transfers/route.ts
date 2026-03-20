import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectTransfers } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, or } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/transfers
// List pending transfers for this org (both incoming and outgoing)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const transfers = await db.query.projectTransfers.findMany({
      where: or(
        eq(projectTransfers.sourceOrgId, orgId),
        eq(projectTransfers.destinationOrgId, orgId),
      ),
      with: {
        project: {
          columns: { id: true, name: true, displayName: true },
        },
        sourceOrg: {
          columns: { id: true, name: true, slug: true },
        },
        destinationOrg: {
          columns: { id: true, name: true, slug: true },
        },
        initiatedByUser: {
          columns: { id: true, name: true, email: true },
        },
        respondedByUser: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    // Tag each transfer as incoming or outgoing relative to this org
    const tagged = transfers.map((t) => ({
      ...t,
      direction: t.sourceOrgId === orgId ? "outgoing" : "incoming",
    }));

    return NextResponse.json({ transfers: tagged });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error listing transfers:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
