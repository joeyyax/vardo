import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { appTransfers, memberships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { acceptTransfer, rejectTransfer } from "@/lib/transfers/engine";
import { recordActivity } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string; transferId: string }>;
};

const respondSchema = z.object({
  action: z.enum(["accept", "reject"]),
});

// POST /api/v1/organizations/[orgId]/transfers/[transferId]
// Accept or reject a transfer (only owners/admins of the destination org)
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, transferId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = respondSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    // Fetch the transfer
    const transfer = await db.query.appTransfers.findFirst({
      where: and(
        eq(appTransfers.id, transferId),
        eq(appTransfers.status, "pending"),
      ),
      with: {
        app: { columns: { id: true, name: true } },
      },
    });

    if (!transfer) {
      return NextResponse.json(
        { error: "Transfer not found or not pending" },
        { status: 404 },
      );
    }

    // Only owners/admins of the destination org can accept/reject
    if (transfer.destinationOrgId !== orgId) {
      return NextResponse.json(
        { error: "Only the destination organization can respond to this transfer" },
        { status: 403 },
      );
    }

    // Verify the current user is an owner/admin of the destination org
    const destMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, session.user.id),
        eq(memberships.organizationId, orgId),
      ),
    });

    if (
      !destMembership ||
      (destMembership.role !== "owner" && destMembership.role !== "admin")
    ) {
      return NextResponse.json(
        { error: "Only owners and admins can accept or reject transfers" },
        { status: 403 },
      );
    }

    const { action } = parsed.data;

    if (action === "accept") {
      await acceptTransfer(transferId, session.user.id);

      // Record activity on both orgs
      recordActivity({
        organizationId: transfer.destinationOrgId,
        action: "transfer.accepted",
        appId: transfer.appId,
        userId: session.user.id,
        metadata: {
          transferId,
          sourceOrgId: transfer.sourceOrgId,
          appName: transfer.app?.name,
        },
      });
      recordActivity({
        organizationId: transfer.sourceOrgId,
        action: "transfer.accepted",
        appId: transfer.appId,
        userId: session.user.id,
        metadata: {
          transferId,
          destinationOrgId: transfer.destinationOrgId,
          appName: transfer.app?.name,
        },
      });

      return NextResponse.json({ success: true, status: "accepted" });
    } else {
      await rejectTransfer(transferId, session.user.id, "rejected");

      recordActivity({
        organizationId: transfer.destinationOrgId,
        action: "transfer.rejected",
        appId: transfer.appId,
        userId: session.user.id,
        metadata: {
          transferId,
          sourceOrgId: transfer.sourceOrgId,
          appName: transfer.app?.name,
        },
      });
      recordActivity({
        organizationId: transfer.sourceOrgId,
        action: "transfer.rejected",
        appId: transfer.appId,
        userId: session.user.id,
        metadata: {
          transferId,
          destinationOrgId: transfer.destinationOrgId,
          appName: transfer.app?.name,
        },
      });

      return NextResponse.json({ success: true, status: "rejected" });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Transfer not found or not pending"
    ) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return handleRouteError(error, "Error responding to transfer");
  }
}
