import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { cronJobs } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemExec } from "@/lib/api/system-exec";
import { can } from "@/lib/auth/permissions";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { runCronJob } from "@/lib/cron/engine";
import { CRON_JOB_APP } from "@/lib/cron/columns";

type RouteParams = {
  params: Promise<{ orgId: string; cronId: string }>;
};

// POST /api/v1/organizations/[orgId]/cron/[cronId]/run
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, cronId } = await params;
    const org = await verifyOrgAccess(orgId, "app.cron");
    if (!org) return apiError.forbidden();

    const job = await db.query.cronJobs.findFirst({
      where: and(eq(cronJobs.id, cronId), eq(cronJobs.organizationId, orgId)),
      with: { app: { ...CRON_JOB_APP, columns: { ...CRON_JOB_APP.columns, isSystemManaged: true } } },
    });
    if (!job) return apiError.notFound("cron job");

    const refused = await refuseSystemExec(org.organization, job.app);
    if (refused) return refused;

    if (job.type === "command" && !can(org.membership, "app.cron.command")) {
      return apiError.forbidden();
    }

    const result = await runCronJob(job);
    if (!result) {
      return NextResponse.json({ error: "This job is already running" }, { status: 409 });
    }

    return NextResponse.json({ run: result });
  } catch (error) {
    return handleRouteError(error, "Error running cron job");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "org-cron-run" });
