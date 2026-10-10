import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { claimNonce, verifyMeshSignature } from "@/lib/mesh/signing";
import { MCP_CALL_PATH, remoteCallSchema } from "@/lib/mcp/dispatch";
import { RemoteCallError, runRemoteCall } from "@/lib/mcp/remote";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const MAX_BODY_BYTES = 1_000_000;

/** POST /api/v1/mesh/mcp-call — run an MCP tool a linked instance forwarded, as the user it names. */
async function handlePost(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);

    for (const plugin of ["mesh", "mcp"] as const) {
      const gate = await requirePlugin(plugin);
      if (gate) return gate;
    }

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Call too large" }, { status: 413 });
    }

    const check = verifyMeshSignature({
      tokenHash: peer.tokenHash ?? "",
      method: "POST",
      path: MCP_CALL_PATH,
      body,
      headers: request.headers,
    });
    if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 401 });
    if (!(await claimNonce(peer.id, check.nonce))) {
      return NextResponse.json({ error: "Replayed or unverifiable call" }, { status: 401 });
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = remoteCallSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid call" }, { status: 400 });
    }

    const result = await runRemoteCall(peer, parsed.data, request.signal);
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof RemoteCallError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return handleRouteError(error, "Error running forwarded MCP call");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "mesh-mcp-call" });
