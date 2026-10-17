import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { localSshKeys, SSH_KEYS_PATH, storePeerSsh, UNLINKED_STATUS } from "@/lib/mesh/ssh-exchange";

/** POST /api/v1/mesh/ssh-keys — trades mesh SSH keys with a linked instance. */
async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, SSH_KEYS_PATH, 4096);
    if ("response" in call) return call.response;
    await storePeerSsh(call.peer, call.json);
    return NextResponse.json(await localSshKeys(call.peer));
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "No link with the calling instance" }, { status: UNLINKED_STATUS });
    }
    return handleRouteError(error, "Error trading mesh SSH keys");
  }
}

export const POST = withRateLimit(handlePost, { tier: "public", key: "mesh-ssh-keys" });
