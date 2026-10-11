import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { claimNonce, verifyMeshSignature } from "@/lib/mesh/signing";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { PROBE_BANS_PATH, receiveSharedBan } from "@/lib/probe-guard/mesh-share";
import { createBan } from "@/lib/probe-guard/bans";
import { getProbeGuardSettings } from "@/lib/probe-guard/instance";

const MAX_BODY_BYTES = 4096;

/** POST /api/v1/mesh/probe-bans — a ban a linked instance shared. Applied here, never sent on. */
async function handlePost(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);
    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Ban too large" }, { status: 413 });

    const check = verifyMeshSignature({ tokenHash: peer.tokenHash ?? "", method: "POST", path: PROBE_BANS_PATH, body, headers: request.headers });
    if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 401 });
    if (!(await claimNonce(peer.id, check.nonce))) {
      return NextResponse.json({ error: "Replayed or unverifiable request" }, { status: 401 });
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const result = await receiveSharedBan(peer, json, {
      sharingEnabled: async () => (await getProbeGuardSettings()).shareBans,
      ban: createBan,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return handleRouteError(error, "Error applying a shared ban");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "mesh-probe-bans" });
