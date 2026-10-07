import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, appTransfers, organizations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { initiateTransfer, analyzeTransfer, rejectTransfer } from "@/lib/transfers/engine";
import { recordActivity } from "@/lib/activity";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const initiateTransferSchema = z.object({
  destinationOrgId: z.string().min(1, "Destination org ID is required"),
  note: z.string().optional(),
}).strict();

// POST /api/v1/organizations/[orgId]/apps/[appId]/transfer
// Initiate an app transfer to another organization.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "org.transfers.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = initiateTransferSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const { destinationOrgId, note } = parsed.data;

    if (destinationOrgId === orgId) {
      return NextResponse.json(
        { error: "Can't transfer an app to the same organization" },
        { status: 400 },
      );
    }

    // Existence only; the destination accepts or rejects.
    // Its contents must not reach this response.
    const destinationOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, destinationOrgId),
      columns: { id: true },
    });

    if (!destinationOrg) {
      return NextResponse.json(
        { error: "Destination organization not found" },
        { status: 404 },
      );
    }

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

    // One pending transfer per app.
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

    const analysis = await analyzeTransfer(appId);

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
        crossProjectRefsCount: analysis.crossProjectRefs.length,
        warningsCount: analysis.warnings.length,
      },
    });

    return NextResponse.json(
      {
        transferId,
        analysis: {
          crossProjectRefs: analysis.crossProjectRefs,
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
// Cancel a pending transfer. Only the initiator can cancel.
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "org.transfers.manage");
    if (!org) return apiError.forbidden();

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

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-transfer" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-transfer" });
