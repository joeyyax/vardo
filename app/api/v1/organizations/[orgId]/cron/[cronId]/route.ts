import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { cronJobs } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemExec } from "@/lib/api/system-exec";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  CronInputError,
  findOrgLevelJob,
  orgCronUpdateSchema,
  recentRuns,
  serializeCronJob,
  updateValues,
} from "@/lib/cron/jobs";

type RouteParams = {
  params: Promise<{ orgId: string; cronId: string }>;
};

// GET /api/v1/organizations/[orgId]/cron/[cronId]
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, cronId } = await params;
    const org = await verifyOrgAccess(orgId, "app.view");
    if (!org) return apiError.forbidden();

    const job = await db.query.cronJobs.findFirst({
      where: and(eq(cronJobs.id, cronId), eq(cronJobs.organizationId, orgId)),
      with: { app: { columns: { id: true, name: true, displayName: true, projectId: true } } },
    });
    if (!job) return apiError.notFound("cron job");

    const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("runs")) || 20, 1), 100);
    return NextResponse.json({ cronJob: serializeCronJob(job), runs: await recentRuns(job.id, limit) });
  } catch (error) {
    return handleRouteError(error, "Error loading cron job");
  }
}

// PATCH /api/v1/organizations/[orgId]/cron/[cronId]
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, cronId } = await params;
    const org = await verifyOrgAccess(orgId, "app.cron");
    if (!org) return apiError.forbidden();

    const refused = await refuseSystemExec(org.organization, null);
    if (refused) return refused;

    const parsed = orgCronUpdateSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);

    const current = await findOrgLevelJob(orgId, cronId);
    if (!current) return apiError.notFound("cron job");

    const [updated] = await db
      .update(cronJobs)
      .set(updateValues(parsed.data, current, orgId))
      .where(and(eq(cronJobs.id, cronId), eq(cronJobs.organizationId, orgId), isNull(cronJobs.appId)))
      .returning();
    if (!updated) return apiError.notFound("cron job");

    return NextResponse.json({ cronJob: serializeCronJob(updated) });
  } catch (error) {
    if (error instanceof CronInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return handleRouteError(error, "Error updating cron job");
  }
}

// DELETE /api/v1/organizations/[orgId]/cron/[cronId]
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, cronId } = await params;
    const org = await verifyOrgAccess(orgId, "app.cron");
    if (!org) return apiError.forbidden();

    const refused = await refuseSystemExec(org.organization, null);
    if (refused) return refused;

    const [deleted] = await db
      .delete(cronJobs)
      .where(and(eq(cronJobs.id, cronId), eq(cronJobs.organizationId, orgId), isNull(cronJobs.appId)))
      .returning({ id: cronJobs.id });
    if (!deleted) return apiError.notFound("cron job");

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting cron job");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/cron/*" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "org-cron" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "org-cron" });
