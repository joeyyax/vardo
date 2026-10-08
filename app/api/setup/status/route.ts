import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextResponse } from "next/server";
import { needsSetup } from "@/lib/setup";

// GET /api/setup/status — unauthenticated, used by middleware/client
async function handleGet() {
  return NextResponse.json({ needsSetup: await needsSetup() });
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/status" });
