import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { MAX_RESULTS_BODY_BYTES, RESULTS_PATH } from "@/lib/uptime/link";
import { receiveRecords } from "@/lib/uptime/serve";

/** POST /api/v1/mesh/uptime/results — a linked instance delivers signed results and hourly summaries for our monitors. */
async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, RESULTS_PATH, MAX_RESULTS_BODY_BYTES);
    if ("response" in call) return call.response;
    const { status, json } = await receiveRecords(call.peer.id, call.json);
    return NextResponse.json(json, { status });
  } catch (error) {
    return handleRouteError(error, "Error receiving uptime results");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "mesh-uptime-results" });
