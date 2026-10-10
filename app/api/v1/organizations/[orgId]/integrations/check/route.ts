import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { listOpenIssues, runIntegrationCheck } from "@/lib/integrations/check";
import { logger } from "@/lib/logger";

const log = logger.child("integration-check");

type RouteParams = { params: Promise<{ orgId: string }> };

// POST — re-reads integration permissions now and says whether anything still needs approval.
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    try {
      await runIntegrationCheck();
    } catch (err) {
      log.warn(`permission check failed: ${err instanceof Error ? err.message : err}`);
      return NextResponse.json({ error: "Couldn't reach GitHub. Try again in a minute." }, { status: 502 });
    }
    const open = (await listOpenIssues(orgId)).length;
    return NextResponse.json({
      open,
      message: open ? "Still waiting on GitHub. Accept the new permissions there, then check again." : "All permissions are in place.",
    });
  } catch (error) {
    return handleRouteError(error, "Error checking integration permissions");
  }
}

export const POST = withRateLimit(handlePost, { tier: "heavy", key: "post:v1/organizations/*/integrations/check" });
