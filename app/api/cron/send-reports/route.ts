import { NextRequest, NextResponse } from "next/server";
import { runAutoReportSending } from "@/lib/reports/auto-send";

/**
 * Cron endpoint for auto-sending weekly reports.
 *
 * This should be called hourly to check for reports that need to be sent.
 * Vercel cron config in vercel.json:
 * {
 *   "crons": [{
 *     "path": "/api/cron/send-reports",
 *     "schedule": "0 * * * *"
 *   }]
 * }
 *
 * Each report config has:
 * - autoSendDay: 0-6 (Sunday = 0)
 * - autoSendHour: 0-23
 *
 * Reports are sent for the previous week's data.
 */
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret in production
    if (process.env.NODE_ENV === "production") {
      const authHeader = request.headers.get("authorization");
      const cronSecret = process.env.CRON_SECRET;

      if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json(
          { error: "Unauthorized" },
          { status: 401 }
        );
      }
    }

    console.log("[Cron] Starting auto report sending...");

    const result = await runAutoReportSending();

    console.log(
      `[Cron] Auto report sending complete: ${result.successful}/${result.processed} successful`
    );

    // Log any failures
    for (const r of result.results.filter((r) => !r.success)) {
      console.error(
        `[Cron] Failed to send report for ${r.clientName || r.projectName}: ${r.error}`
      );
    }

    return NextResponse.json({
      success: true,
      processed: result.processed,
      successful: result.successful,
      failed: result.failed,
      results: result.results,
    });
  } catch (error) {
    console.error("[Cron] Error in auto report sending:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// Also support POST for manual triggering
export async function POST(request: NextRequest) {
  return GET(request);
}
