import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { restoreBackup } from "@/lib/backup/engine";

type RouteParams = {
  params: Promise<{ orgId: string; backupId: string }>;
};

// POST /api/v1/organizations/[orgId]/backups/[backupId]/restore
export async function POST(_request: NextRequest, { params }: RouteParams) {
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
          columns: { id: true, organizationId: true },
        },
      },
    });

    if (!backup || backup.project.organizationId !== orgId) {
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
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error restoring backup:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
