import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { appTransfers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { acceptTransfer, rejectTransfer } from "@/lib/transfers/engine";
import { recordActivity } from "@/lib/activity";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; transferId: string }>;
};

const respondSchema = z.object({
  action: z.enum(["accept", "reject"]),
}).strict();

// POST /api/v1/organizations/[orgId]/transfers/[transferId]
// Accept or reject a transfer (only owners/admins of the destination org)
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, transferId } = await params;
    const org = await verifyOrgAccess(orgId, "org.transfers.manage");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = respondSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    // Scoped to the destination org: a transfer addressed to anyone else is
    // indistinguishable from one that does not exist.
    const transfer = await db.query.appTransfers.findFirst({
      where: and(
        eq(appTransfers.id, transferId),
        eq(appTransfers.destinationOrgId, orgId),
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

    const { action } = parsed.data;

    if (action === "accept") {
      await acceptTransfer(transferId, org.session.user.id);

      recordActivity({
        organizationId: transfer.destinationOrgId,
        action: "transfer.accepted",
        appId: transfer.appId,
        userId: org.session.user.id,
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
        userId: org.session.user.id,
        metadata: {
          transferId,
          destinationOrgId: transfer.destinationOrgId,
          appName: transfer.app?.name,
        },
      });

      return NextResponse.json({ success: true, status: "accepted" });
    } else {
      await rejectTransfer(transferId, org.session.user.id, "rejected");

      recordActivity({
        organizationId: transfer.destinationOrgId,
        action: "transfer.rejected",
        appId: transfer.appId,
        userId: org.session.user.id,
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
        userId: org.session.user.id,
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

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-transfers" });
