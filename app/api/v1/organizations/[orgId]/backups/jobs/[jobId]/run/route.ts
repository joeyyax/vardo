import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupJobs } from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq, and } from "drizzle-orm";
import { runSucceeded } from "@/lib/backups/engine";
import { startManualBackup } from "@/lib/backups/manual-run";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; jobId: string }>;
};

// POST /api/v1/organizations/[orgId]/backups/jobs/[jobId]/run
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId, jobId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.run");
    if (!org) return apiError.forbidden();

    const job = await db.query.backupJobs.findFirst({
      where: and(
        eq(backupJobs.id, jobId),
        eq(backupJobs.organizationId, orgId)
      ),
    });

    if (!job) {
      return apiError.notFound("backup job");
    }

    const start = await startManualBackup(jobId);
    if (!start.started) {
      return NextResponse.json(
        { error: "Using the run of this backup job already in progress.", code: "BACKUP_IN_PROGRESS", startedAt: start.startedAt?.toISOString() ?? null },
        { status: 409 },
      );
    }
    const results = await start.done;

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
