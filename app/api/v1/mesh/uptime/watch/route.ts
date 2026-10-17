import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { MAX_WATCH_BODY_BYTES, WATCH_PATH } from "@/lib/uptime/link";
import { serveWatchList } from "@/lib/uptime/serve";

/** POST /api/v1/mesh/uptime/watch — a linked instance announces its vantage point and gets our signed watch list. */
async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, WATCH_PATH, MAX_WATCH_BODY_BYTES);
    if ("response" in call) return call.response;
    const { status, json } = await serveWatchList(call.peer.id, call.json);
    return NextResponse.json(json, { status });
  } catch (error) {
    return handleRouteError(error, "Error serving uptime watch list");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "mesh-uptime-watch" });
