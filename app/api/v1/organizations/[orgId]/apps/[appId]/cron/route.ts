import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { cronJobs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { refuseSystemExec } from "@/lib/api/system-exec";
import { can } from "@/lib/auth/permissions";
import { requirePlugin } from "@/lib/api/require-plugin";
import {
  CronInputError,
  cronCreateSchema,
  cronUpdateSchema,
  createValues,
  serializeCronJob,
  updateValues,
} from "@/lib/cron/jobs";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const updateCronSchema = cronUpdateSchema.extend({ id: z.string().min(1) }).strict();

const deleteCronSchema = z.object({
  id: z.string().min(1),
}).strict();

// GET /api/v1/organizations/[orgId]/apps/[appId]/cron
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId, "app.view");

    if (!app) {
      return apiError.notFound("app");
    }

    const jobs = await db.query.cronJobs.findMany({
      where: eq(cronJobs.appId, appId),
      orderBy: (cronJobs, { asc }) => [asc(cronJobs.name)],
    });

    return NextResponse.json({ cronJobs: jobs.map(serializeCronJob) });
  } catch (error) {
    return handleRouteError(error, "Error listing cron jobs");
  }
}

// POST /api/v1/organizations/[orgId]/apps/[appId]/cron
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, appId } = await params;
    const orgAccess = await verifyOrgAccess(orgId, "app.cron");
    if (!orgAccess) return apiError.forbidden();
    const app = await verifyAppAccess(orgId, appId, "app.cron");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = await refuseSystemExec(orgAccess.organization, app);
    if (refused) return refused;

    const body = await request.json();
    const parsed = cronCreateSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    if (parsed.data.type === "command" && !can(orgAccess.membership, "app.cron.command")) {
      return apiError.forbidden();
    }

    const [created] = await db
      .insert(cronJobs)
      .values(createValues(parsed.data, orgId, appId))
      .returning();

    return NextResponse.json({ cronJob: serializeCronJob(created) }, { status: 201 });
  } catch (error) {
    if (error instanceof CronInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return handleRouteError(error, "Error creating cron job");
  }
}

// PATCH /api/v1/organizations/[orgId]/apps/[appId]/cron
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, appId } = await params;
    const orgAccess = await verifyOrgAccess(orgId, "app.cron");
    if (!orgAccess) return apiError.forbidden();
    const app = await verifyAppAccess(orgId, appId, "app.cron");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = await refuseSystemExec(orgAccess.organization, app);
    if (refused) return refused;

    const body = await request.json();
    const parsed = updateCronSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const { id, ...updates } = parsed.data;

    const current = await db.query.cronJobs.findFirst({
      where: and(eq(cronJobs.id, id), eq(cronJobs.appId, appId)),
      columns: { type: true, command: true, headers: true },
    });
    if (!current) return apiError.notFound("cron job");

    // A member may pause, rename or reschedule a command job, not change what it runs.
    if (!can(orgAccess.membership, "app.cron.command") && (updates.type || updates.command !== undefined)) {
      const type = updates.type ?? current.type;
      const commandChanged = updates.command !== undefined && updates.command !== current.command;
      const typeChanged = type !== current.type;
      if (type === "command" && (commandChanged || typeChanged)) return apiError.forbidden();
    }

    const [updated] = await db
      .update(cronJobs)
      .set(updateValues(updates, { ...current, headers: current.headers ?? null }, orgId))
      .where(and(eq(cronJobs.id, id), eq(cronJobs.appId, appId)))
      .returning();

    if (!updated) {
      return apiError.notFound("cron job");
    }

    return NextResponse.json({ cronJob: serializeCronJob(updated) });
  } catch (error) {
    if (error instanceof CronInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return handleRouteError(error, "Error updating cron job");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/cron
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("cron");
    if (gate) return gate;

    const { orgId, appId } = await params;
    const orgAccess = await verifyOrgAccess(orgId, "app.cron");
    if (!orgAccess) return apiError.forbidden();
    const app = await verifyAppAccess(orgId, appId, "app.cron");

    if (!app) {
      return apiError.notFound("app");
    }

    const refused = await refuseSystemExec(orgAccess.organization, app);
    if (refused) return refused;

    const body = await request.json();
    const parsed = deleteCronSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const [deleted] = await db
      .delete(cronJobs)
      .where(
        and(
          eq(cronJobs.id, parsed.data.id),
          eq(cronJobs.appId, appId)
        )
      )
      .returning({ id: cronJobs.id });

    if (!deleted) {
      return apiError.notFound("cron job");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting cron job");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "apps-cron" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "apps-cron" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "apps-cron" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/cron" });
