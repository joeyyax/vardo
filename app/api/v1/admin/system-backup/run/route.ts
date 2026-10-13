import { NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";
import { requireAppAdmin } from "@/lib/auth/admin";
import { runSucceeded } from "@/lib/backups/engine";
import { startManualBackup } from "@/lib/backups/manual-run";
import { findSystemJob } from "@/lib/backups/system-storage";

// POST /api/v1/admin/system-backup/run — back up Vardo's own database now
async function handlePost() {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    await requireAppAdmin();

    const job = await findSystemJob();
    if (!job) return apiError.notFound("system backup job");

    const start = await startManualBackup(job.id);
    if (!start.started) return NextResponse.json({ error: "The system backup is already running.", code: "BACKUP_IN_PROGRESS" }, { status: 409 });
    const results = await start.done;

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
