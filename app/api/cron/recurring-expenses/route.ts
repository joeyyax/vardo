import { NextRequest, NextResponse } from "next/server";
import { processRecurringExpenses } from "@/lib/expenses/recurring";

// This endpoint processes recurring expenses
// Should be called daily by a cron job (Vercel cron, external service, etc.)
//
// Security: Protected by CRON_SECRET environment variable
// Set up: Add CRON_SECRET to your environment variables
// Call with: Authorization: Bearer <CRON_SECRET>
//
// Vercel cron config (vercel.json):
// {
//   "crons": [{
//     "path": "/api/cron/recurring-expenses",
//     "schedule": "0 6 * * *"
//   }]
// }

export async function GET(request: NextRequest) {
  // Verify the request is from a trusted source
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  // In development, allow without auth for testing
  const isDev = process.env.NODE_ENV === "development";

  if (!isDev) {
    if (!cronSecret) {
      console.error("CRON_SECRET not configured");
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 }
      );
    }

    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }
  }

  try {
    const result = await processRecurringExpenses();

    console.log(
      `[Recurring Expenses] Processed: ${result.processed}, Generated: ${result.generated}, Errors: ${result.errors.length}`
    );

    if (result.errors.length > 0) {
      console.error("[Recurring Expenses] Errors:", result.errors);
    }

    return NextResponse.json({
      success: true,
      processed: result.processed,
      generated: result.generated,
      errors: result.errors,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Recurring Expenses] Fatal error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

// Also support POST for flexibility
export async function POST(request: NextRequest) {
  return GET(request);
}
