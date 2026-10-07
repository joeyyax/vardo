import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { APP_DELETED_RESTORE_ERROR, restoreBackup } from "@/lib/backups/engine";
import { findOrgAppBackup } from "@/lib/backups/org-backup";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; backupId: string }>;
};

// POST /api/v1/organizations/[orgId]/backups/[backupId]/restore
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, backupId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.restore");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const backup = await findOrgAppBackup(orgId, backupId);
    if (!backup) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!backup.app) {
      return NextResponse.json({ error: APP_DELETED_RESTORE_ERROR }, { status: 409 });
    }

    if (backup.status !== "success") {
      return NextResponse.json(
        { error: "Only successful backups can be restored" },
        { status: 400 },
      );
    }

    const result = await restoreBackup(backupId);

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error restoring backup");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "history-restore" });
