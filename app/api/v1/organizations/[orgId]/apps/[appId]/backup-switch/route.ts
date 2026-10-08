import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { applyBackupSwitch, getAppBackupSwitchState, resolveAppBackupSwitch } from "@/lib/backups/switch";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

async function loadApp(orgId: string, appId: string) {
  return db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
    columns: { id: true, name: true, organizationId: true, parentAppId: true, backupsEnabled: true },
    with: { organization: { columns: { backupsEnabled: true } } },
  });
}

function stateOf(app: NonNullable<Awaited<ReturnType<typeof loadApp>>>) {
  return getAppBackupSwitchState({
    id: app.id,
    organizationId: app.organizationId,
    backupsEnabled: app.backupsEnabled,
    orgBackupsEnabled: app.organization?.backupsEnabled ?? null,
  });
}

// GET /api/v1/organizations/[orgId]/apps/[appId]/backup-switch
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.view");
    if (!org) return apiError.forbidden();

    const app = await loadApp(orgId, appId);
    if (!app) return apiError.notFound("app");
    if (app.parentAppId) {
      return NextResponse.json({ error: "Backups are set on the stack" }, { status: 409 });
    }

    return NextResponse.json(await stateOf(app));
  } catch (error) {
    return handleRouteError(error, "Error reading backup switch");
  }
}

const putSchema = z.object({ enabled: z.boolean().nullable() }).strict();

// PUT /api/v1/organizations/[orgId]/apps/[appId]/backup-switch — null inherits
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.jobs.manage");
    if (!org) return apiError.forbidden();

    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const app = await loadApp(orgId, appId);
    if (!app) return apiError.notFound("app");
    if (app.parentAppId) {
      return NextResponse.json({ error: "Backups are set on the stack" }, { status: 409 });
    }

    const { enabled } = parsed.data;
    await db.update(apps).set({ backupsEnabled: enabled, updatedAt: new Date() }).where(eq(apps.id, app.id));

    const resolved = await resolveAppBackupSwitch(app.id);
    if (resolved) {
      await applyBackupSwitch(app, resolved.enabled, { reenable: true });
    }

    recordActivity({
      organizationId: orgId,
      action: enabled === null ? "backup.app_inherited" : enabled ? "backup.app_enrolled" : "backup.app_unenrolled",
      appId: app.id,
      userId: org.session.user.id,
      metadata: { enabled },
    }).catch(() => {});

    return NextResponse.json(await stateOf({ ...app, backupsEnabled: enabled }));
  } catch (error) {
    return handleRouteError(error, "Error changing backup switch");
  }
}

export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "backup-switch" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps/*/backup-switch" });
