import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { cronJobs } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { verifyAppAccess, verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemExec } from "@/lib/api/system-exec";
import { can } from "@/lib/auth/permissions";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { runCronJob } from "@/lib/cron/engine";
import { CRON_JOB_APP } from "@/lib/cron/columns";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; cronId: string }>;
};

// POST /api/v1/organizations/[orgId]/apps/[appId]/cron/[cronId]/run
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, appId, cronId } = await params;
    const orgAccess = await verifyOrgAccess(orgId, "app.cron");
    if (!orgAccess) return apiError.forbidden();
    const app = await verifyAppAccess(orgId, appId, "app.cron");
    if (!app) return apiError.notFound("app");

    const refused = await refuseSystemExec(orgAccess.organization, app);
    if (refused) return refused;

    const job = await db.query.cronJobs.findFirst({
      where: and(eq(cronJobs.id, cronId), eq(cronJobs.appId, appId)),
      with: { app: CRON_JOB_APP },
    });
    if (!job) return apiError.notFound("cron job");

    if (job.type === "command" && !can(orgAccess.membership, "app.cron.command")) {
      return apiError.forbidden();
    }

    const result = await runCronJob(job);
    if (!result) {
      return NextResponse.json(
        { error: "This job is already running" },
        { status: 409 },
      );
    }

    return NextResponse.json({ run: result });
  } catch (error) {
    return handleRouteError(error, "Error running cron job");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-cron-run" });
