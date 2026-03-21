import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupJobs } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { runBackup } from "@/lib/backup/engine";

type RouteParams = {
  params: Promise<{ orgId: string; jobId: string }>;
};

// POST /api/v1/organizations/[orgId]/backups/[jobId]/run
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, jobId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify job exists and belongs to org
    const job = await db.query.backupJobs.findFirst({
      where: and(
        eq(backupJobs.id, jobId),
        eq(backupJobs.organizationId, orgId)
      ),
    });

    if (!job) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Run the backup (this will create history records)
    const results = await runBackup(jobId);

    const allSucceeded = results.every((r) => r.success);

    return NextResponse.json({
      success: allSucceeded,
      results,
    });
  } catch (error) {
    return handleRouteError(error, "Error running backup");
  }
}
