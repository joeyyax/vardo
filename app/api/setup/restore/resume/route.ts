import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { currentRestore, resumeScheduledJobs } from "@/lib/restore/queue";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";

// POST /api/setup/restore/resume — turn back on the backup and cron jobs the restore paused.
async function handler(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const run = await currentRestore();
    if (!run) return apiError.notFound("restore");
    return NextResponse.json(await resumeScheduledJobs(run.id));
  } catch (error) {
    return handleRouteError(error, "Error resuming scheduled jobs");
  }
}

export const POST = withRateLimit(handler, { tier: "admin", key: "setup-restore-resume" });
