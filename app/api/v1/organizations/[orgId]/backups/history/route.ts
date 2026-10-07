import { NextRequest, NextResponse } from "next/server";
import { and, count, eq, isNull } from "drizzle-orm";
import { handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps, backups } from "@/lib/db/schema";
import { deleteBackups, isInProgress, storedBytes } from "@/lib/backups/delete-backups";
import { orgBackupScope } from "@/lib/backups/org-backup";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

/**
 * The history of a deleted app (?appId=) or deleted job (?jobName=). Returns
 * a response to send when the request can't name one.
 */
async function deletedHistoryScope(request: NextRequest, orgId: string) {
  const appId = request.nextUrl.searchParams.get("appId");
  const jobName = request.nextUrl.searchParams.get("jobName");
  if (!appId === !jobName) {
    return { denied: NextResponse.json({ error: "Pass appId or jobName" }, { status: 400 }) };
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
  return {
    where: and(orgBackupScope(orgId), isNull(backups.jobId), eq(backups.jobName, jobName!))!,
  };
}

// GET /api/v1/organizations/[orgId]/backups/history?appId=|jobName=
// What deleting that history would remove.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.view");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

// DELETE /api/v1/organizations/[orgId]/backups/history?appId=|jobName=
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.delete");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const scope = await deletedHistoryScope(request, orgId);
    if (scope.denied) return scope.denied;

    const rows = await db.query.backups.findMany({
      where: scope.where,
      columns: { id: true, targetId: true, status: true, storagePath: true },
    });
    const { deleted, kept } = await deleteBackups(rows.filter((r) => !isInProgress(r.status)));

    return NextResponse.json({ deleted, kept });
  } catch (error) {
    return handleRouteError(error, "Error deleting backup history");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "backup-delete" });
