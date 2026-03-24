import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { requireAppAdmin } from "@/lib/auth/admin";
import { isFeatureEnabled } from "@/lib/config/features";
import { eq } from "drizzle-orm";
import { restoreSystemBackup } from "@/lib/backup/engine";

type RouteParams = {
  params: Promise<{ backupId: string }>;
};

// POST /api/v1/admin/backups/[backupId]/restore
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("backups")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }
    await requireAppAdmin();
    const { backupId } = await params;

    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, backupId),
    });

    if (!backup) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (backup.status !== "success") {
      return NextResponse.json(
        { error: "Only successful backups can be restored" },
        { status: 400 },
      );
    }

    if (backup.volumeName !== "postgres") {
      return NextResponse.json(
        { error: "This endpoint only restores system database backups" },
        { status: 400 },
      );
    }

    const result = await restoreSystemBackup(backupId);

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error restoring system backup");
  }
}
