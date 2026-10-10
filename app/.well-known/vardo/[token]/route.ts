import { NextRequest, NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { answerReachToken } from "@/lib/domains/reach";

export const dynamic = "force-dynamic";

const HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

// The token's HMAC while it's live, so dns-check knows this Vardo answered.
async function handleGet(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const signature = await answerReachToken(token);
  if (!signature) return new NextResponse("Not found\n", { status: 404, headers: HEADERS });
  return new NextResponse(signature, { status: 200, headers: HEADERS });
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:well-known/vardo" });
