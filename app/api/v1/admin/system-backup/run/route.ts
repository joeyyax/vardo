import { NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";
import { requireAppAdmin } from "@/lib/auth/admin";
import { MANUAL_TRIGGER, runBackup, runSucceeded } from "@/lib/backups/engine";
import { findSystemJob } from "@/lib/backups/system-storage";

// POST /api/v1/admin/system-backup/run — back up Vardo's own database now
async function handlePost() {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    await requireAppAdmin();

    const job = await findSystemJob();
    if (!job) return apiError.notFound("system backup job");

    const results = await runBackup(job.id, { trigger: MANUAL_TRIGGER });

    return NextResponse.json({
      success: runSucceeded(results),
      skipped: results.filter((r) => r.outcome === "skipped").length,
      results,
    });
  } catch (error) {
    return handleRouteError(error, "Error running system backup");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "admin-system-backup-run" });
