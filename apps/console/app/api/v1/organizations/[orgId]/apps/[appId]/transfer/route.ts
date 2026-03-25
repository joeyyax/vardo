import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, appTransfers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { initiateTransfer, analyzeTransfer, rejectTransfer } from "@/lib/transfers/engine";
import { recordActivity } from "@/lib/activity";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const initiateTransferSchema = z.object({
  destinationOrgId: z.string().min(1, "Destination org ID is required"),
  note: z.string().optional(),
}).strict();

// POST /api/v1/organizations/[orgId]/apps/[appId]/transfer
// Initiate an app transfer to another organization
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (org.membership.role !== "owner" && org.membership.role !== "admin") {
      return NextResponse.json(
        { error: "Only owners and admins can initiate transfers" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const parsed = initiateTransferSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const { destinationOrgId, note } = parsed.data;

    if (destinationOrgId === orgId) {
      return NextResponse.json(
        { error: "Cannot transfer an app to the same organization" },
        { status: 400 },
      );
    }

    // Verify the app exists in this org
    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId),
      ),
      columns: { id: true, name: true },
    });

    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

    // Check there isn't already a pending transfer for this app
    const existing = await db.query.appTransfers.findFirst({
      where: and(
        eq(appTransfers.appId, appId),
        eq(appTransfers.status, "pending"),
      ),
    });

    if (existing) {
      return NextResponse.json(
        { error: "A pending transfer already exists for this app" },
        { status: 409 },
      );
    }

    // Run analysis and create the transfer
    const analysis = await analyzeTransfer(appId, orgId, destinationOrgId);

    const transferId = await initiateTransfer({
      appId: appId,
      sourceOrgId: orgId,
      destinationOrgId,
      initiatedBy: org.session.user.id,
      note,
    });

    recordActivity({
      organizationId: orgId,
      action: "transfer.initiated",
      appId,
      userId: org.session.user.id,
      metadata: {
        transferId,
        destinationOrgId,
        frozenRefsCount: analysis.frozenRefs.length,
        warningsCount: analysis.warnings.length,
      },
    });

    return NextResponse.json(
      {
        transferId,
        analysis: {
          frozenRefs: analysis.frozenRefs,
          warnings: analysis.warnings,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error, "Error initiating transfer");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/transfer
// Cancel a pending transfer (only the initiator can cancel)
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Find the pending transfer for this app
    const transfer = await db.query.appTransfers.findFirst({
      where: and(
        eq(appTransfers.appId, appId),
        eq(appTransfers.sourceOrgId, orgId),
        eq(appTransfers.status, "pending"),
      ),
    });

    if (!transfer) {
      return NextResponse.json(
        { error: "No pending transfer found for this app" },
        { status: 404 },
      );
    }

    if (transfer.initiatedBy !== org.session.user.id) {
      return NextResponse.json(
        { error: "Only the initiator can cancel a transfer" },
        { status: 403 },
      );
    }

    await rejectTransfer(transfer.id, org.session.user.id, "cancelled");

    recordActivity({
      organizationId: orgId,
      action: "transfer.cancelled",
      appId,
      userId: org.session.user.id,
      metadata: { transferId: transfer.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling transfer");
  }
}
