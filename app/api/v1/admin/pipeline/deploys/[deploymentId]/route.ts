import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { requestCancel } from "@/lib/deploy/queue";
import { readDeployDetail } from "@/lib/pipeline/deploy-detail";

type RouteParams = { params: Promise<{ deploymentId: string }> };

// GET /api/v1/admin/pipeline/deploys/[deploymentId]
// Facts and log tail for the Pipeline drill-in.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    await requireAppAdmin();
    const { deploymentId } = await params;
    const detail = await readDeployDetail(deploymentId);
    return detail ? NextResponse.json(detail) : apiError.notFound("deployment");
  } catch (error) {
    return handleRouteError(error, "Error reading the deploy");
  }
}

// DELETE /api/v1/admin/pipeline/deploys/[deploymentId]
// Cancels a queued or running deploy in any org, as the app's own cancel does.
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    await requireAppAdmin();
    const { deploymentId } = await params;
    const detail = await readDeployDetail(deploymentId);
    if (!detail) return apiError.notFound("deployment");
    if (!detail.cancellable) {
      return NextResponse.json({ error: "Only queued or running deploys can be cancelled. A rollback finishes on its own." }, { status: 409 });
    }
    const outcome = await requestCancel(deploymentId, "user");
    if (outcome === "inactive") return NextResponse.json({ error: "Only queued or running deploys can be cancelled." }, { status: 409 });
    return NextResponse.json(outcome === "cancelled" ? { ok: true } : { ok: true, cancelling: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling the deploy");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/pipeline/deploy" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-deployments" });
