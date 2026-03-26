import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; deploymentId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]
// Cancel a queued deployment before it starts
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, deploymentId } = await params;

    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const deployment = await db.query.deployments.findFirst({
      where: and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)),
      columns: { id: true, status: true },
    });

    if (!deployment) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (deployment.status !== "queued") {
      return NextResponse.json(
        { error: "Only queued deployments can be cancelled" },
        { status: 409 },
      );
    }

    await db
      .update(deployments)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling deployment");
  }
}
