import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
};

// GET /api/v1/organizations/[orgId]/clients/[clientId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await db.query.clients.findFirst({
      where: and(
        eq(clients.id, clientId),
        eq(clients.organizationId, orgId)
      ),
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    return NextResponse.json(client);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching client:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/clients/[clientId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // First verify the client exists and belongs to this org
    const existingClient = await db.query.clients.findFirst({
      where: and(
        eq(clients.id, clientId),
        eq(clients.organizationId, orgId)
      ),
    });

    if (!existingClient) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const body = await request.json();
    const { name, color, rateOverride, isBillable } = body;

    // Build update object with only provided fields
    const updates: Partial<{
      name: string;
      color: string | null;
      rateOverride: number | null;
      isBillable: boolean | null;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
          { error: "Name cannot be empty" },
          { status: 400 }
        );
      }
      updates.name = name.trim();
    }

    if (color !== undefined) {
      updates.color = color || null;
    }

    if (rateOverride !== undefined) {
      // Convert rate from dollars to cents if provided, null if empty/null
      updates.rateOverride =
        rateOverride !== null && rateOverride !== "" && rateOverride !== undefined
          ? Math.round(parseFloat(rateOverride) * 100)
          : null;
    }

    if (isBillable !== undefined) {
      updates.isBillable = isBillable;
    }

    const [updatedClient] = await db
      .update(clients)
      .set(updates)
      .where(
        and(eq(clients.id, clientId), eq(clients.organizationId, orgId))
      )
      .returning();

    return NextResponse.json(updatedClient);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error updating client:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/clients/[clientId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // First verify the client exists and belongs to this org
    const existingClient = await db.query.clients.findFirst({
      where: and(
        eq(clients.id, clientId),
        eq(clients.organizationId, orgId)
      ),
    });

    if (!existingClient) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    await db
      .delete(clients)
      .where(
        and(eq(clients.id, clientId), eq(clients.organizationId, orgId))
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error deleting client:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
