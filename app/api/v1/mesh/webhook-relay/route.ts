import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { claimNonce, verifyMeshSignature } from "@/lib/mesh/signing";
import { receiveRelay } from "@/lib/mesh/webhook-relay-receive";
import { MAX_RELAY_RAW_BYTES, WEBHOOK_RELAY_PATH } from "@/lib/git-integration/webhook-event";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const MAX_BODY_BYTES = MAX_RELAY_RAW_BYTES + 16_384;

/** POST /api/v1/mesh/webhook-relay — a GitHub push or pull request event a linked instance relayed. */
async function handlePost(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);

    for (const plugin of ["mesh", "git-integration"] as const) {
      const gate = await requirePlugin(plugin);
      if (gate) return gate;
    }

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Relay too large" }, { status: 413 });
    }

    const check = verifyMeshSignature({
      tokenHash: peer.tokenHash ?? "",
      method: "POST",
      path: WEBHOOK_RELAY_PATH,
      body,
      headers: request.headers,
    });
    if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 401 });
    if (!(await claimNonce(peer.id, check.nonce))) {
      return NextResponse.json({ error: "Replayed or unverifiable relay" }, { status: 401 });
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    return await receiveRelay(peer, json);
  } catch (error) {
    return handleRouteError(error, "Error handling relayed webhook");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "mesh-webhook-relay" });
