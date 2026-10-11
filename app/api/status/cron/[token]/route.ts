import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { publicCronStatus, toPublicJson } from "@/lib/cron/public-status";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type RouteParams = { params: Promise<{ token: string }> };

// GET /api/status/cron/[token]: public. 200 whether ok or not; monitors match on "ok":true.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  const status = await publicCronStatus(token);
  if (!status) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json(toPublicJson(status), { headers: NO_STORE });
}

export const GET = withRateLimit(handleGet, { tier: "public", key: "get:status/cron/*" });
