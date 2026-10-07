import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { deleteBackups, isInProgress } from "@/lib/backups/delete-backups";
import { findOrgAppBackup } from "@/lib/backups/org-backup";

type RouteParams = {
  params: Promise<{ orgId: string; backupId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/backups/history/[backupId]
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, backupId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.delete");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const backup = await findOrgAppBackup(orgId, backupId);
    if (!backup) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (isInProgress(backup.status)) {
      return NextResponse.json({ error: "This backup is still running" }, { status: 409 });
    }

    const { deleted } = await deleteBackups([backup]);
    if (deleted === 0) {
      return NextResponse.json(
        { error: "Couldn't delete the archive from storage, so the backup was kept" },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting backup");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "backup-delete" });
