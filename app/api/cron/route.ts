import { NextRequest, NextResponse } from "next/server";
import { runAutoInvoiceGeneration } from "@/lib/invoices/auto-generate";
import { runAutoReportSending } from "@/lib/reports/auto-send";

/**
 * Unified cron endpoint for all scheduled tasks.
 *
 * Call this endpoint on a schedule (e.g., hourly) to run:
 * - Auto-invoice generation (runs once daily at configured hour)
 * - Auto-report sending (checks hourly for scheduled sends)
 *
 * Example cron: 0 * * * * (every hour at minute 0)
 *
 * Environment variables:
 * - CRON_SECRET: Bearer token for authentication
 * - CRON_INVOICE_HOUR: Hour (0-23) to run invoice generation (default: 14 = 2pm)
 * - TZ: Timezone for hour calculation (default: UTC)
 *
 * Query params:
 * - force=true: Run all tasks regardless of hour (for manual triggers)
 *
 * Security: Set CRON_SECRET env var and pass as Bearer token:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://yourapp.com/api/cron
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";

  try {
    // Verify cron secret in production
    if (process.env.NODE_ENV === "production") {
      const authHeader = request.headers.get("authorization");
      const cronSecret = process.env.CRON_SECRET;

      if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const currentHour = new Date().getHours();
    const invoiceHour = parseInt(process.env.CRON_INVOICE_HOUR || "14", 10);

    console.log(`[Cron] Starting scheduled tasks... (current hour: ${currentHour}, invoice hour: ${invoiceHour})`);

    const results: {
      task: string;
      success: boolean;
      processed?: number;
      successful?: number;
      failed?: number;
      error?: string;
    }[] = [];

    // Run auto-invoice generation (only at configured hour, or if forced)
    const shouldRunInvoices = force || currentHour === invoiceHour;

    if (shouldRunInvoices) {
      try {
        console.log("[Cron] Running auto-invoice generation...");
        const invoiceResult = await runAutoInvoiceGeneration();
        results.push({
          task: "generate-invoices",
          success: true,
          processed: invoiceResult.processed,
          successful: invoiceResult.successful,
          failed: invoiceResult.failed,
        });
        console.log(
          `[Cron] Invoice generation: ${invoiceResult.successful}/${invoiceResult.processed} successful`
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : "Unknown error";
        console.error("[Cron] Invoice generation failed:", error);
        results.push({
          task: "generate-invoices",
          success: false,
          error,
        });
      }
    } else {
      results.push({
        task: "generate-invoices",
        success: true,
        processed: 0,
        successful: 0,
        failed: 0,
      });
      console.log(`[Cron] Skipping invoice generation (runs at hour ${invoiceHour})`);
    }

    // Run auto-report sending
    try {
      console.log("[Cron] Running auto-report sending...");
      const reportResult = await runAutoReportSending();
      results.push({
        task: "send-reports",
        success: true,
        processed: reportResult.processed,
        successful: reportResult.successful,
        failed: reportResult.failed,
      });
      console.log(
        `[Cron] Report sending: ${reportResult.successful}/${reportResult.processed} successful`
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      console.error("[Cron] Report sending failed:", error);
      results.push({
        task: "send-reports",
        success: false,
        error,
      });
    }

    const duration = Date.now() - startTime;
    console.log(`[Cron] All tasks complete in ${duration}ms`);

    return NextResponse.json({
      success: results.every((r) => r.success),
      duration: `${duration}ms`,
      results,
    });
  } catch (error) {
    console.error("[Cron] Fatal error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// Support POST for flexibility
export async function POST(request: NextRequest) {
  return GET(request);
}
