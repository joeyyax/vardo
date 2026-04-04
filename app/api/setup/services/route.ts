import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";

import { withRateLimit } from "@/lib/api/with-rate-limit";

// Metrics and logs are always enabled — no opt-out.
// This route is kept for backwards compatibility but always returns true.

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  return NextResponse.json({
    configured: true,
    metrics: true,
    logs: true,
  });
}

async function handlePost(request: NextRequest) {
  await requireAdminAuth(request);

  // No-op: metrics and logs are always on.
  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-services" });
