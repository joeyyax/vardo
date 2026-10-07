import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";

import { withRateLimit } from "@/lib/api/with-rate-limit";

// Metrics and logs are always on. Kept for backwards compatibility.

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

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-services" });
