import { NextResponse } from "next/server";
import { needsSetup } from "@/lib/setup";

// GET /api/setup/status — unauthenticated, used by middleware/client
export async function GET() {
  return NextResponse.json({ needsSetup: await needsSetup() });
}
