import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { publishKillSignal } from "@/lib/docker/deploy-cancel";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; deploymentId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/deployments/[deploymentId]
// Cancel a queued or running deployment
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

    if (deployment.status !== "queued" && deployment.status !== "running") {
      return NextResponse.json(
        { error: "Only queued or running deployments can be cancelled" },
        { status: 409 },
      );
    }

    if (deployment.status === "running") {
      // Signal the running deploy process to abort at the next stage boundary.
      // The worker checks this key in deploy-cancel.ts and aborts its AbortController.
      await publishKillSignal(deploymentId);
      // The worker updates the status to "cancelled" when it handles the signal.
      // We return immediately — the UI will reflect the cancellation via the event stream.
      return NextResponse.json({ ok: true });
    }

    // Queued deployments have not started yet — update the DB directly.
    await db
      .update(deployments)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling deployment");
  }
}
