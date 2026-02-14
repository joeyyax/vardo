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
    const {
      name,
      color,
      contactEmail,
      rateOverride,
      isBillable,
      billingType,
      billingFrequency,
      autoGenerateInvoices,
      retainerAmount,
      includedMinutes,
      overageRate,
      billingDayOfWeek,
      billingDayOfMonth,
      paymentTermsDays,
      parentClientId,
    } = body;

    // Build update object with only provided fields
    const updates: Partial<{
      name: string;
      color: string | null;
      contactEmail: string | null;
      rateOverride: number | null;
      isBillable: boolean | null;
      billingType: string | null;
      billingFrequency: string | null;
      autoGenerateInvoices: boolean;
      retainerAmount: number | null;
      includedMinutes: number | null;
      overageRate: number | null;
      billingDayOfWeek: number | null;
      billingDayOfMonth: number | null;
      paymentTermsDays: number | null;
      parentClientId: string | null;
      assignedTo: string | null;
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

    if (contactEmail !== undefined) {
      updates.contactEmail = contactEmail || null;
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

    if (billingType !== undefined) {
      updates.billingType = billingType || null;
    }

    if (billingFrequency !== undefined) {
      updates.billingFrequency = billingFrequency || null;
    }

    if (autoGenerateInvoices !== undefined) {
      updates.autoGenerateInvoices = autoGenerateInvoices;
    }

    if (retainerAmount !== undefined) {
      // Convert retainer from dollars to cents if provided
      updates.retainerAmount =
        retainerAmount !== null && retainerAmount !== "" && retainerAmount !== undefined
          ? Math.round(parseFloat(retainerAmount) * 100)
          : null;
    }

    if (includedMinutes !== undefined) {
      updates.includedMinutes =
        includedMinutes !== null && includedMinutes !== ""
          ? Math.round(Number(includedMinutes))
          : null;
    }

    if (overageRate !== undefined) {
      // Convert from dollars to cents if provided
      updates.overageRate =
        overageRate !== null && overageRate !== "" && overageRate !== undefined
          ? Math.round(parseFloat(overageRate) * 100)
          : null;
    }

    if (billingDayOfWeek !== undefined) {
      updates.billingDayOfWeek = billingDayOfWeek;
    }

    if (billingDayOfMonth !== undefined) {
      updates.billingDayOfMonth = billingDayOfMonth;
    }

    if (paymentTermsDays !== undefined) {
      updates.paymentTermsDays = paymentTermsDays;
    }

    if (parentClientId !== undefined) {
      // Allow clearing parent with null or empty string
      if (parentClientId === null || parentClientId === "") {
        updates.parentClientId = null;
      } else {
        // Cannot set self as parent
        if (parentClientId === clientId) {
          return NextResponse.json(
            { error: "Client cannot be its own parent" },
            { status: 400 }
          );
        }
        // Validate parent exists and belongs to same org
        const parentClient = await db.query.clients.findFirst({
          where: and(
            eq(clients.id, parentClientId),
            eq(clients.organizationId, orgId)
          ),
        });
        if (!parentClient) {
          return NextResponse.json(
            { error: "Parent client not found" },
            { status: 400 }
          );
        }
        // Prevent setting a child client as parent (only one level of nesting)
        if (parentClient.parentClientId) {
          return NextResponse.json(
            { error: "Cannot set a child client as parent (max one level of nesting)" },
            { status: 400 }
          );
        }
        // Check if this client has children - if so, it cannot become a child
        const hasChildren = await db.query.clients.findFirst({
          where: and(
            eq(clients.parentClientId, clientId),
            eq(clients.organizationId, orgId)
          ),
        });
        if (hasChildren) {
          return NextResponse.json(
            { error: "Client with children cannot have a parent (max one level of nesting)" },
            { status: 400 }
          );
        }
        updates.parentClientId = parentClientId;
      }
    }

    if ("assignedTo" in body) {
      updates.assignedTo = body.assignedTo || null;
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
