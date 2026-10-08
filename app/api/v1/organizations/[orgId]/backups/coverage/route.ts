import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { apps, backupTargets } from "@/lib/db/schema";
import { resolveBackupTarget } from "@/lib/backups/auto-backup";
import { listUncoveredApps, optInApp } from "@/lib/backups/enroll";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/backups/coverage
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.jobs.manage");
    if (!org) return apiError.forbidden();

    const [uncovered, defaultTarget] = await Promise.all([
      listUncoveredApps(orgId),
      resolveBackupTarget(orgId),
    ]);
    return NextResponse.json({ apps: uncovered, defaultTargetId: defaultTarget?.id ?? null });
  } catch (error) {
    return handleRouteError(error, "Error listing backup coverage");
  }
}

const optInSchema = z
  .object({
    appId: z.string().min(1),
    targetId: z.string().min(1).optional(),
    volumeIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

// POST /api/v1/organizations/[orgId]/backups/coverage — opt one app in
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.jobs.manage");
    if (!org) return apiError.forbidden();

    const parsed = optInSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }
    const { appId, targetId, volumeIds } = parsed.data;

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true },
    });
    if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });

    const target = targetId
      ? await db.query.backupTargets.findFirst({
          where: and(
            eq(backupTargets.id, targetId),
            or(eq(backupTargets.organizationId, orgId), isNull(backupTargets.organizationId)),
          ),
          columns: { id: true },
        })
      : await resolveBackupTarget(orgId);
    if (!target) {
      return targetId
        ? NextResponse.json({ error: "Backup target not found" }, { status: 404 })
        : NextResponse.json({ error: "No backup target is configured" }, { status: 409 });
    }

    const result = await optInApp({
      appId: app.id,
      appName: app.name,
      organizationId: orgId,
      targetId: target.id,
      volumeIds,
    });
    await db.update(apps).set({ backupsEnabled: true, updatedAt: new Date() }).where(eq(apps.id, app.id));

    recordActivity({
      organizationId: orgId,
      action: "backup.app_enrolled",
      appId: app.id,
      userId: org.session.user.id,
      metadata: { jobId: result.jobId, targetId: target.id, volumeIds: result.included },
    }).catch(() => {});

    return NextResponse.json({ jobId: result.jobId, included: result.included });
  } catch (error) {
    return handleRouteError(error, "Error enrolling app in backups");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "backup-coverage" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/backups/coverage" });
