import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clients, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { getAccessibleProjectIds, requireAdmin } from "@/lib/auth/permissions";
import { eq, and, inArray } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/clients
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session, membership } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const accessibleProjectIds = await getAccessibleProjectIds(session.user.id, membership.role);

    const orgClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
      orderBy: (clients, { asc }) => [asc(clients.name)],
    });

    // Members can only see clients that have at least one assigned project
    if (accessibleProjectIds !== null) {
      if (accessibleProjectIds.length === 0) {
        return NextResponse.json([]);
      }
      const assignedProjects = await db.query.projects.findMany({
        where: inArray(projects.id, accessibleProjectIds),
        columns: { clientId: true },
      });
      const allowedClientIds = [...new Set(assignedProjects.map((p) => p.clientId))];
      const filteredClients = orgClients.filter((c) => allowedClientIds.includes(c.id));
      return NextResponse.json(filteredClients);
    }

    return NextResponse.json(orgClients);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching clients:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/clients
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Only admins/owners can create clients
    requireAdmin(membership.role);

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

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    // Convert rate from dollars to cents if provided
    const rateInCents =
      rateOverride !== null && rateOverride !== undefined && rateOverride !== ""
        ? Math.round(parseFloat(rateOverride) * 100)
        : null;

    // Convert retainer amount from dollars to cents if provided
    const retainerInCents =
      retainerAmount !== null && retainerAmount !== undefined && retainerAmount !== ""
        ? Math.round(parseFloat(retainerAmount) * 100)
        : null;

    // Validate parentClientId if provided - must belong to same org
    if (parentClientId) {
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
    }

    const [newClient] = await db
      .insert(clients)
      .values({
        organizationId: orgId,
        name: name.trim(),
        color: color || null,
        contactEmail: contactEmail || null,
        rateOverride: rateInCents,
        isBillable: isBillable ?? null,
        billingType: billingType || null,
        billingFrequency: billingFrequency || null,
        autoGenerateInvoices: autoGenerateInvoices ?? false,
        retainerAmount: retainerInCents,
        includedMinutes: includedMinutes != null ? Math.round(Number(includedMinutes)) : null,
        overageRate:
          overageRate != null && overageRate !== ""
            ? Math.round(parseFloat(overageRate) * 100)
            : null,
        billingDayOfWeek: billingDayOfWeek ?? null,
        billingDayOfMonth: billingDayOfMonth ?? null,
        paymentTermsDays: paymentTermsDays ?? null,
        parentClientId: parentClientId || null,
      })
      .returning();

    return NextResponse.json(newClient, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error creating client:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
