import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { requireAdminAuth } from "@/lib/auth/admin";

import { withRateLimit } from "@/lib/api/with-rate-limit";

// Metrics and logs are always on. Kept for backwards compatibility.

export async function GET(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  return NextResponse.json({
    configured: true,
    metrics: true,
    logs: true,
  });
}

async function handlePost(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-services" });
