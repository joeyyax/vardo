import { NextRequest, NextResponse } from "next/server";
import { runAutoInvoiceGeneration } from "@/lib/invoices/auto-generate";

/**
 * Cron endpoint for auto-generating invoices.
 *
 * Prefer using the unified /api/cron endpoint which handles scheduling.
 * This endpoint is available for manual triggering or if you need
 * to run invoice generation separately.
 *
 * For security, this endpoint verifies the CRON_SECRET header in production.
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

    console.log("[Cron] Starting auto-invoice generation...");

    const result = await runAutoInvoiceGeneration();

    console.log(
      `[Cron] Auto-invoice generation complete: ${result.successful}/${result.processed} successful`
    );

    // Log any failures
    for (const r of result.results.filter((r) => !r.success)) {
      console.error(
        `[Cron] Failed to generate invoice for client ${r.clientName}: ${r.error}`
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
    console.error("[Cron] Error in auto-invoice generation:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// Also support POST for manual triggering or other cron providers
export async function POST(request: NextRequest) {
  return GET(request);
}
