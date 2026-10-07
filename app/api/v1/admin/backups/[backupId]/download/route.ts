import { NextRequest } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { requireAppAdmin } from "@/lib/auth/admin";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq } from "drizzle-orm";
import { backupDownloadResponse } from "@/lib/backups/download-response";
import { recordAdminBackupActivity } from "@/app/api/v1/admin/backups/record-activity";

type RouteParams = {
  params: Promise<{ backupId: string }>;
};

// GET /api/v1/admin/backups/[backupId]/download
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const session = await requireAppAdmin();
    const { backupId } = await params;

    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, backupId),
    });

    if (!backup || backup.status !== "success" || !backup.storagePath) {
      return apiError.notFound("backup");
    }

    recordAdminBackupActivity("backup.downloaded", backup, session.user.id).catch(() => {});

    const fileName = `${backup.volumeName ?? "backup"}-${backup.startedAt.toISOString().slice(0, 10)}.tar.gz`;
    return await backupDownloadResponse(backupId, fileName);
  } catch (error) {
    return handleRouteError(error, "Error downloading system backup");
  }
}
