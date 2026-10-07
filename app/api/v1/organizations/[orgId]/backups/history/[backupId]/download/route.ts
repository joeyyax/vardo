import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { backupDownloadResponse } from "@/lib/backups/download-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { findOrgAppBackup } from "@/lib/backups/org-backup";

type RouteParams = {
  params: Promise<{ orgId: string; backupId: string }>;
};

// GET /api/v1/organizations/[orgId]/backups/[backupId]/download
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, backupId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const backup = await findOrgAppBackup(orgId, backupId);
    if (!backup) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (backup.status !== "success" || !backup.storagePath) {
      return NextResponse.json(
        { error: "Backup is not available for download" },
        { status: 400 },
      );
    }

    const fileName = `${backup.app?.name ?? backup.appName ?? "vardo"}-${backup.volumeName ?? "backup"}-${backup.startedAt.toISOString().slice(0, 10)}.tar.gz`;
    return await backupDownloadResponse(backupId, fileName);
  } catch (error) {
    return handleRouteError(error, "Error generating backup download");
  }
}
