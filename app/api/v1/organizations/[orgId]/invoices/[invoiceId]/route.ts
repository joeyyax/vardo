import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invoices, invoiceLineItems, retainerPeriods } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; invoiceId: string }>;
};

// GET /api/v1/organizations/[orgId]/invoices/[invoiceId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.id, invoiceId),
        eq(invoices.organizationId, orgId)
      ),
      with: {
        client: true,
        lineItems: true,
        organization: true,
      },
    });

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    return NextResponse.json({
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        subtotal: invoice.subtotal,
        totalMinutes: invoice.totalMinutes,
        publicToken: invoice.publicToken,
        notes: invoice.notes,
        includeTimesheet: invoice.includeTimesheet,
        createdAt: invoice.createdAt.toISOString(),
        sentAt: invoice.sentAt?.toISOString() || null,
        viewedAt: invoice.viewedAt?.toISOString() || null,
      },
      client: {
        id: invoice.client.id,
        name: invoice.client.name,
        color: invoice.client.color,
      },
      organization: {
        id: invoice.organization.id,
        name: invoice.organization.name,
      },
      lineItems: invoice.lineItems.map((item) => ({
        id: item.id,
        projectName: item.projectName,
        taskName: item.taskName,
        description: item.description,
        minutes: item.minutes,
        rate: item.rate,
        amount: item.amount,
      })),
    });
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
    console.error("Error fetching invoice:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/invoices/[invoiceId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Check if invoice exists and belongs to org
    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.id, invoiceId),
        eq(invoices.organizationId, orgId)
      ),
    });

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if (invoice.status === "voided") {
      return NextResponse.json(
        { error: "Cannot modify a voided invoice" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const {
      invoiceNumber,
      status,
      notes,
      includeTimesheet,
      totalMinutes,
      subtotal,
      lineItems,
    } = body;

    // Update invoice fields
    const updateData: Record<string, unknown> = {};
    if (invoiceNumber !== undefined) updateData.invoiceNumber = invoiceNumber;
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (includeTimesheet !== undefined) updateData.includeTimesheet = includeTimesheet;
    if (totalMinutes !== undefined) updateData.totalMinutes = totalMinutes;
    if (subtotal !== undefined) updateData.subtotal = subtotal;

    if (Object.keys(updateData).length > 0) {
      await db
        .update(invoices)
        .set(updateData)
        .where(eq(invoices.id, invoiceId));
    }

    // Update line items if provided
    if (lineItems && Array.isArray(lineItems)) {
      for (const item of lineItems) {
        if (item.id) {
          await db
            .update(invoiceLineItems)
            .set({
              description: item.description,
              minutes: item.minutes,
              rate: item.rate,
              amount: item.amount,
            })
            .where(eq(invoiceLineItems.id, item.id));
        }
      }

      // Delete removed line items
      const keepIds = lineItems.map((i: { id: string }) => i.id).filter(Boolean);
      if (keepIds.length > 0) {
        const existingItems = await db.query.invoiceLineItems.findMany({
          where: eq(invoiceLineItems.invoiceId, invoiceId),
        });
        for (const existing of existingItems) {
          if (!keepIds.includes(existing.id)) {
            await db
              .delete(invoiceLineItems)
              .where(eq(invoiceLineItems.id, existing.id));
          }
        }
      }
    }

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
    console.error("Error updating invoice:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/invoices/[invoiceId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Check if invoice exists and belongs to org
    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.id, invoiceId),
        eq(invoices.organizationId, orgId)
      ),
    });

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if (invoice.status === "voided") {
      return NextResponse.json(
        { error: "Invoice is already voided" },
        { status: 400 }
      );
    }

    if (invoice.status === "draft") {
      // Hard delete drafts
      await db.delete(invoices).where(eq(invoices.id, invoiceId));
      return NextResponse.json({ success: true, action: "deleted" });
    }

    // Void non-draft invoices (sent, viewed, paid)
    await db.transaction(async (tx) => {
      await tx
        .update(invoices)
        .set({ status: "voided", voidedAt: new Date() })
        .where(eq(invoices.id, invoiceId));

      // Un-link any retainer periods tied to this invoice
      await tx
        .update(retainerPeriods)
        .set({ invoiceId: null, status: "active" })
        .where(eq(retainerPeriods.invoiceId, invoiceId));
    });

    return NextResponse.json({ success: true, action: "voided" });
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
    console.error("Error deleting invoice:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
