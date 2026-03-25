import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/config/features";
import { eq } from "drizzle-orm";
import { restoreBackup } from "@/lib/backup/engine";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; backupId: string }>;
};

// POST /api/v1/organizations/[orgId]/backups/[backupId]/restore
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("backups")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }
    const { orgId, backupId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Verify the backup belongs to a project in this org
    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, backupId),
      with: {
        app: {
          columns: { id: true, organizationId: true },
        },
      },
    });

    if (!backup || !backup.app || backup.app.organizationId !== orgId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
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
