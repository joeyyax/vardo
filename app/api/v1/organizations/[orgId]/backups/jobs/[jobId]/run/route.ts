import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupJobs } from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq, and } from "drizzle-orm";
import { runBackup, runSucceeded } from "@/lib/backups/engine";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; jobId: string }>;
};

// POST /api/v1/organizations/[orgId]/backups/[jobId]/run
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId, jobId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.run");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

    return NextResponse.json({
      success: runSucceeded(results),
      skipped: results.filter((r) => r.outcome === "skipped").length,
      results,
    });
  } catch (error) {
    return handleRouteError(error, "Error running backup");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "jobs-run" });
