import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getOrCreateClientIntakeToken } from "@/lib/intake-email";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
};

// POST /api/v1/organizations/[orgId]/clients/[clientId]/intake-token
// Generate or retrieve the intake email address for a client
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify client belongs to org
    const client = await db.query.clients.findFirst({
      where: and(
        eq(clients.id, clientId),
        eq(clients.organizationId, orgId)
      ),
      columns: { id: true },
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const result = await getOrCreateClientIntakeToken(clientId);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error generating client intake token:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
