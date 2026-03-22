import { NextResponse } from "next/server";
import { getSystemHealth } from "@/lib/config/health";

// GET /api/health/system — full system health for the dashboard UI
export async function GET() {
  try {
    const health = await getSystemHealth();
    return NextResponse.json(health);
  } catch (err) {
    console.error("[health/system] Error:", err);
    return NextResponse.json(
      { error: "Failed to retrieve system health" },
      { status: 500 },
    );
  }
}
