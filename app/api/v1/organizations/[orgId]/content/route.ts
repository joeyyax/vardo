import { NextRequest, NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { clients, invoices, reportConfigs, timeEntries } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ orgId: string }>;
};

/**
 * DELETE /api/v1/organizations/[orgId]/content
 * Clear all organization content (entries, invoices, clients, projects, tasks)
 * Keeps: organization settings, memberships
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { orgId } = await context.params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Only owners can clear content
    if (membership.role !== "owner") {
      return NextResponse.json(
        { error: "Only organization owners can clear content" },
        { status: 403 }
      );
    }

    // Verify confirmation
    const body = await request.json();
    if (body.confirm !== organization.name) {
      return NextResponse.json(
        { error: "Confirmation text does not match organization name" },
        { status: 400 }
      );
    }

    // Delete in order to respect foreign keys
    // Time entries first (references clients, projects, tasks)
    const deletedEntries = await db
      .delete(timeEntries)
      .where(eq(timeEntries.organizationId, orgId))
      .returning({ id: timeEntries.id });

    // Invoices (references clients, has cascade to line items)
    const deletedInvoices = await db
      .delete(invoices)
      .where(eq(invoices.organizationId, orgId))
      .returning({ id: invoices.id });

    // Report configs
    const deletedReports = await db
      .delete(reportConfigs)
      .where(eq(reportConfigs.organizationId, orgId))
      .returning({ id: reportConfigs.id });

    // Clients (cascade deletes projects and tasks)
    const deletedClients = await db
      .delete(clients)
      .where(eq(clients.organizationId, orgId))
      .returning({ id: clients.id });

    return NextResponse.json({
      success: true,
      deleted: {
        timeEntries: deletedEntries.length,
        invoices: deletedInvoices.length,
        reportConfigs: deletedReports.length,
        clients: deletedClients.length,
      },
    });
  } catch (error) {
    console.error("Error clearing organization content:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to clear content" },
      { status: 500 }
    );
  }
}
