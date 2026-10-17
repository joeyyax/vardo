import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { KEYS_PATH, localKeys, storePeerKeys, UNLINKED_STATUS } from "@/lib/mesh/key-exchange";

/** POST /api/v1/mesh/ssh-keys — trades builder keys and certificates with a linked instance. */
async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, KEYS_PATH, 16_384);
    if ("response" in call) return call.response;
    const stored = await storePeerKeys(call.peer, call.json);
    return NextResponse.json(await localKeys({ ...call.peer, ...stored }));
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "No link with the calling instance" }, { status: UNLINKED_STATUS });
    }
    return handleRouteError(error, "Error trading mesh keys");
  }
}

export const POST = withRateLimit(handlePost, { tier: "public", key: "mesh-ssh-keys" });
