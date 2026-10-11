// Receiving side of a signed peer call: bearer token, plugin gate, size, signature, nonce, then JSON.

import { NextRequest, NextResponse } from "next/server";
import { requireMeshPeer } from "./auth";
import { claimNonce, verifyMeshSignature } from "./signing";
import { requirePlugin } from "@/lib/api/require-plugin";

type MeshPeerRow = Awaited<ReturnType<typeof requireMeshPeer>>;

/** The calling peer and its parsed body, or the response that refuses it. Throws "Unauthorized" like requireMeshPeer. */
export async function readSignedMeshCall(
  request: NextRequest,
  path: string,
  maxBytes: number,
): Promise<{ peer: MeshPeerRow; json: unknown } | { response: NextResponse }> {
  const peer = await requireMeshPeer(request);
  const gate = await requirePlugin("mesh");
  if (gate) return { response: gate };

  const body = await request.text();
  if (body.length > maxBytes) return { response: NextResponse.json({ error: "Request too large" }, { status: 413 }) };

  const check = verifyMeshSignature({ tokenHash: peer.tokenHash ?? "", method: "POST", path, body, headers: request.headers });
  if (!check.ok) return { response: NextResponse.json({ error: check.reason }, { status: 401 }) };
  if (!(await claimNonce(peer.id, check.nonce))) {
    return { response: NextResponse.json({ error: "Replayed or unverifiable request" }, { status: 401 }) };
  }

  try {
    return { peer, json: JSON.parse(body) };
  } catch {
    return { response: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}
