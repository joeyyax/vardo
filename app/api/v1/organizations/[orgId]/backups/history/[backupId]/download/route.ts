import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { backupDownloadResponse } from "@/lib/backups/download-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { recordActivity } from "@/lib/activity";
import { findOrgAppBackup } from "@/lib/backups/org-backup";
import { downloadFileName, formatFromArchiveName } from "@/lib/backups/archive-name";

type RouteParams = {
  params: Promise<{ orgId: string; backupId: string }>;
};

// GET /api/v1/organizations/[orgId]/backups/[backupId]/download
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, backupId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.download");
    if (!org) return apiError.forbidden();

    const backup = await findOrgAppBackup(orgId, backupId);
    if (!backup) {
      return apiError.notFound("backup");
    }

    if (backup.status !== "success" || !backup.storagePath) {
      return NextResponse.json(
        { error: "Backup isn't available for download" },
        { status: 400 },
      );
    }

    recordActivity({
      organizationId: orgId,
      action: "backup.downloaded",
      appId: backup.app?.id,
      userId: org.session.user.id,
      metadata: { backupId, volumeName: backup.volumeName },
    }).catch(() => {});

    const fileName = downloadFileName(
      `${backup.app?.name ?? backup.appName ?? "vardo"}-${backup.volumeName ?? "backup"}-${backup.startedAt.toISOString().slice(0, 10)}`,
      backup.strategy === "dump" ? "dump" : formatFromArchiveName(backup.storagePath),
    );
    return await backupDownloadResponse(backupId, fileName);
  } catch (error) {
    return handleRouteError(error, "Error generating backup download");
  }
}

export const GET = withRateLimit(handleGet, { tier: "heavy", key: "get:v1/organizations/*/backups/history/*/download" });
