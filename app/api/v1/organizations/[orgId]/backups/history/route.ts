import { NextRequest, NextResponse } from "next/server";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps, backups } from "@/lib/db/schema";
import { deleteBackups, isInProgress, storedBytes } from "@/lib/backups/delete-backups";
import { deletedAppBackupScope, orgBackupScope } from "@/lib/backups/org-backup";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

/** The history of a deleted app (?appId= or ?appName=) or job (?jobName=), or an error response. */
async function deletedHistoryScope(request: NextRequest, orgId: string) {
  const appId = request.nextUrl.searchParams.get("appId");
  const appName = request.nextUrl.searchParams.get("appName");
  const jobName = request.nextUrl.searchParams.get("jobName");
  if ([appId, appName, jobName].filter(Boolean).length !== 1) {
    return { denied: NextResponse.json({ error: "Pass appId, appName or jobName" }, { status: 400 }) };
  }

  if (appId) {
    const live = await db.query.apps.findFirst({ where: eq(apps.id, appId), columns: { id: true } });
    if (live) {
      return {
        denied: NextResponse.json(
          { error: "This app still exists. Delete its backups one at a time." },
          { status: 409 },
        ),
      };
    }
    return { where: and(orgBackupScope(orgId), eq(backups.appId, appId))! };
  }
  if (appName) {
    return { where: and(deletedAppBackupScope(orgId), eq(backups.appName, appName))! };
  }
  return {
    where: and(orgBackupScope(orgId), isNull(backups.jobId), eq(backups.jobName, jobName!))!,
  };
}

/** The org's deleted apps that still have history, by name. */
async function listDeletedApps(orgId: string) {
  const rows = await db
    .select({
      appName: backups.appName,
      appIds: sql<string[]>`array_agg(distinct ${backups.appId} order by ${backups.appId})`,
      backups: count(),
      archives: sql<number>`count(*) filter (where ${backups.storagePath} is not null and ${backups.status} not in ('pruned', 'pending', 'running'))::int`,
      bytes: storedBytes,
    })
    .from(backups)
    .where(deletedAppBackupScope(orgId))
    .groupBy(backups.appName)
    .orderBy(asc(backups.appName));

  return rows.map((r) => ({ ...r, bytes: Number(r.bytes) }));
}

// GET /api/v1/organizations/[orgId]/backups/history?appId=|appName=|jobName=
// What deleting that history would remove. With no query, the deleted apps that still have history.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.view");
    if (!org) return apiError.forbidden();

    if (request.nextUrl.searchParams.size === 0) {
      return NextResponse.json({ apps: await listDeletedApps(orgId) });
    }

    const scope = await deletedHistoryScope(request, orgId);
    if (scope.denied) return scope.denied;

    const [stats] = await db
      .select({
        backups: count(),
        bytes: storedBytes,
      })
      .from(backups)
      .where(scope.where);

    return NextResponse.json({
      backups: Number(stats?.backups ?? 0),
      bytes: Number(stats?.bytes ?? 0),
    });
  } catch (error) {
    return handleRouteError(error, "Error summarizing backup history");
  }
}

// DELETE /api/v1/organizations/[orgId]/backups/history?appId=|appName=|jobName=
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.delete");
    if (!org) return apiError.forbidden();

    const scope = await deletedHistoryScope(request, orgId);
    if (scope.denied) return scope.denied;

    const rows = await db.query.backups.findMany({
      where: scope.where,
      columns: { id: true, targetId: true, status: true, storagePath: true, volumeName: true, startedAt: true },
    });
    const { deleted, kept, failed } = await deleteBackups(rows.filter((r) => !isInProgress(r.status)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    return NextResponse.json({
      deleted,
      kept,
      failed: failed.map((f) => ({
        id: f.id,
        volumeName: byId.get(f.id)?.volumeName ?? null,
        startedAt: byId.get(f.id)?.startedAt ?? null,
        error: f.error,
      })),
    });
  } catch (error) {
    return handleRouteError(error, "Error deleting backup history");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "backup-delete" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/backups/history" });
