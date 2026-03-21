import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { getBackupDownloadUrl, downloadBackupToTemp } from "@/lib/backup/engine";
import { createReadStream } from "fs";
import { rm } from "fs/promises";

type RouteParams = {
  params: Promise<{ orgId: string; backupId: string }>;
};

// GET /api/v1/organizations/[orgId]/backups/[backupId]/download
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, backupId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify the backup belongs to a project in this org
    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, backupId),
      with: {
        project: {
          columns: { id: true, name: true, organizationId: true },
        },
      },
    });

    if (!backup || backup.project.organizationId !== orgId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (backup.status !== "success" || !backup.storagePath) {
      return NextResponse.json(
        { error: "Backup is not available for download" },
        { status: 400 },
      );
    }

    // Try pre-signed URL first (S3 targets)
    const url = await getBackupDownloadUrl(backupId);
    if (url) {
      return NextResponse.redirect(url);
    }

    // SSH targets: download to temp and stream through server
    const tempPath = await downloadBackupToTemp(backupId);
    const fileName = `${backup.project.name}-${backup.volumeName ?? "backup"}-${backup.startedAt.toISOString().slice(0, 10)}.tar.gz`;

    try {
      const stream = createReadStream(tempPath);
      const webStream = new ReadableStream({
        start(controller) {
          stream.on("data", (chunk) => controller.enqueue(chunk));
          stream.on("end", () => {
            controller.close();
            // Clean up temp file after streaming
            rm(tempPath, { force: true }).catch(() => {});
            // Also remove parent dir
            const dir = tempPath.substring(0, tempPath.lastIndexOf("/"));
            rm(dir, { recursive: true, force: true }).catch(() => {});
          });
          stream.on("error", (err) => {
            controller.error(err);
            rm(tempPath, { force: true }).catch(() => {});
          });
        },
      });

      return new Response(webStream, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    } catch {
      await rm(tempPath, { force: true }).catch(() => {});
      throw new Error("Failed to stream backup file");
    }
  } catch (error) {
    return handleRouteError(error, "Error generating backup download");
  }
}
