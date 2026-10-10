import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { cronJobs } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemExec } from "@/lib/api/system-exec";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  CronInputError,
  createValues,
  listOrgCronJobs,
  orgCronCreateSchema,
  serializeCronJob,
} from "@/lib/cron/jobs";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/cron
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    return NextResponse.json({ cronJobs: await listOrgCronJobs(orgId) });
  } catch (error) {
    return handleRouteError(error, "Error listing cron jobs");
  }
}

// POST /api/v1/organizations/[orgId]/cron
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "app.cron");
    if (!org) return apiError.forbidden();

    const refused = await refuseSystemExec(org.organization, null);
    if (refused) return refused;

    const parsed = orgCronCreateSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);

    const [created] = await db
      .insert(cronJobs)
      .values(createValues(parsed.data, orgId, null))
      .returning();

    return NextResponse.json({ cronJob: serializeCronJob(created) }, { status: 201 });
  } catch (error) {
    if (error instanceof CronInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return handleRouteError(error, "Error creating cron job");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/cron" });
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "org-cron" });
