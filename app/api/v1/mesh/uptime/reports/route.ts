import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { MAX_REPORT_BODY_BYTES, REPORTS_PATH } from "@/lib/uptime/link";
import { receiveReport } from "@/lib/uptime/reports";

/** POST /api/v1/mesh/uptime/reports — a linked instance we watch sends its signed report on the monitors we don't check. */
async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, REPORTS_PATH, MAX_REPORT_BODY_BYTES);
    if ("response" in call) return call.response;
    const { status, json } = await receiveReport(call.peer.id, call.json);
    return NextResponse.json(json, { status });
  } catch (error) {
    return handleRouteError(error, "Error receiving uptime report");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "mesh-uptime-reports" });
