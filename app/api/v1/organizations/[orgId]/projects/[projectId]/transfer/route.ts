import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects, projectTransfers } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { initiateTransfer, analyzeTransfer, rejectTransfer } from "@/lib/transfers/engine";
import { recordActivity } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

const initiateTransferSchema = z.object({
  destinationOrgId: z.string().min(1, "Destination org ID is required"),
  note: z.string().optional(),
});

// POST /api/v1/organizations/[orgId]/projects/[projectId]/transfer
// Initiate a project transfer to another organization
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (membership.role !== "owner" && membership.role !== "admin") {
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
        { error: "Cannot transfer a project to the same organization" },
        { status: 400 },
      );
    }

    // Verify the project exists in this org
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId),
      ),
      columns: { id: true, name: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Check there isn't already a pending transfer for this project
    const existing = await db.query.projectTransfers.findFirst({
      where: and(
        eq(projectTransfers.projectId, projectId),
        eq(projectTransfers.status, "pending"),
      ),
    });

    if (existing) {
      return NextResponse.json(
        { error: "A pending transfer already exists for this project" },
        { status: 409 },
      );
    }

    // Run analysis and create the transfer
    const analysis = await analyzeTransfer(projectId, orgId, destinationOrgId);

    const transferId = await initiateTransfer({
      projectId,
      sourceOrgId: orgId,
      destinationOrgId,
      initiatedBy: session.user.id,
      note,
    });

    recordActivity({
      organizationId: orgId,
      action: "transfer.initiated",
      projectId,
      userId: session.user.id,
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

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/transfer
// Cancel a pending transfer (only the initiator can cancel)
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Find the pending transfer for this project
    const transfer = await db.query.projectTransfers.findFirst({
      where: and(
        eq(projectTransfers.projectId, projectId),
        eq(projectTransfers.sourceOrgId, orgId),
        eq(projectTransfers.status, "pending"),
      ),
    });

    if (!transfer) {
      return NextResponse.json(
        { error: "No pending transfer found for this project" },
        { status: 404 },
      );
    }

    if (transfer.initiatedBy !== session.user.id) {
      return NextResponse.json(
        { error: "Only the initiator can cancel a transfer" },
        { status: 403 },
      );
    }

    await rejectTransfer(transfer.id, session.user.id, "cancelled");

    recordActivity({
      organizationId: orgId,
      action: "transfer.cancelled",
      projectId,
      userId: session.user.id,
      metadata: { transferId: transfer.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling transfer");
  }
}
