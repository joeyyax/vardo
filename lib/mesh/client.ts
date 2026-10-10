import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { openOutboundToken } from "./outbound-token";
import { signMeshRequest } from "./signing";
import { recordTunnelFailure, recordTunnelOk } from "./tunnel-status";

type PeerTarget = { name: string; apiUrl: string | null; publicApiUrl: string | null };

/** The peer's URLs and the decrypted token it issued us. Throws MeshClientError. */
async function peerCredentials(peerId: string): Promise<{ peer: PeerTarget; token: string }> {
  const peer = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.id, peerId),
    columns: { apiUrl: true, publicApiUrl: true, outboundToken: true, name: true },
  });

  if (!peer) {
    throw new MeshClientError(`Peer not found: ${peerId}`, "PEER_NOT_FOUND");
  }

  if (!peer.apiUrl && !peer.publicApiUrl) {
    throw new MeshClientError(
      `Peer "${peer.name}" has no API URL configured`,
      "NO_API_URL"
    );
  }

  if (!peer.outboundToken) {
    throw new MeshClientError(
      `No outbound token for peer "${peer.name}" — re-pair to exchange tokens`,
      "NO_TOKEN"
    );
  }

  const outboundToken = openOutboundToken(peer.outboundToken);
  if (!outboundToken) {
    throw new MeshClientError(
      `Outbound token for peer "${peer.name}" can't be decrypted with the running ENCRYPTION_MASTER_KEY`,
      "NO_TOKEN"
    );
  }

  return { peer, token: outboundToken };
}

/** Authenticated request to a mesh peer's API: WireGuard URL first, then the public API URL. */
export async function meshFetch(
  peerId: string,
  path: string,
  options: RequestInit = {},
  { requireTls = false }: { requireTls?: boolean } = {}
): Promise<Response> {
  const { peer, token: outboundToken } = await peerCredentials(peerId);

  const authHeaders = {
    ...options.headers,
    Authorization: `Bearer ${outboundToken}`,
  };

  if (peer.apiUrl) {
    try {
      const res = await fetch(`${peer.apiUrl}${path}`, {
        ...options,
        headers: authHeaders,
        signal: AbortSignal.timeout(5_000),
      });
      recordTunnelOk(peerId, peer.name);
      return res;
    } catch (err) {
      recordTunnelFailure(peerId, peer.name, peer.apiUrl, err);
    }
  }

  if (peer.publicApiUrl) {
    if (requireTls && !peer.publicApiUrl.startsWith("https://")) {
      throw new MeshClientError(
        `Peer "${peer.name}" is off the mesh and its public URL isn't HTTPS; refusing to send secrets`,
        "INSECURE"
      );
    }
    const res = await fetch(`${peer.publicApiUrl}${path}`, {
      ...options,
      headers: authHeaders,
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
    return res;
  }

  throw new MeshClientError(
    `Peer "${peer.name}" unreachable via mesh and has no public URL`,
    "UNREACHABLE"
  );
}

/** JSON request to a mesh peer. Throws with the peer's error message on non-2xx. */
export async function meshJsonFetch<T = unknown>(
  peerId: string,
  path: string,
  options: RequestInit = {},
  transport: { requireTls?: boolean } = {}
): Promise<T> {
  const res = await meshFetch(peerId, path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  }, transport);

  if (!res.ok) {
    let message = `Peer returned ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {}
    throw new MeshClientError(message, "PEER_ERROR", res.status);
  }

  return res.json() as Promise<T>;
}

export type MeshTransport = "tunnel" | "public";

/** True when the tunnel URL answers at all; the status doesn't matter. */
async function tunnelAnswers(peerId: string, name: string, apiUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    recordTunnelOk(peerId, name);
    return true;
  } catch (err) {
    recordTunnelFailure(peerId, name, apiUrl, err);
    return false;
  }
}

/** Signed JSON POST sent once: the tunnel when a probe answers, else the HTTPS public URL. Never retried across transports. */
export async function meshSignedPost<T = unknown>(
  peerId: string,
  path: string,
  payload: unknown,
  { timeoutMs = 120_000, probeMs = 3_000 }: { timeoutMs?: number; probeMs?: number } = {}
): Promise<{ data: T; transport: MeshTransport }> {
  const { peer, token } = await peerCredentials(peerId);

  let base: string;
  let transport: MeshTransport;
  if (peer.apiUrl && (await tunnelAnswers(peerId, peer.name, peer.apiUrl, probeMs))) {
    base = peer.apiUrl;
    transport = "tunnel";
  } else if (peer.publicApiUrl?.startsWith("https://")) {
    base = peer.publicApiUrl;
    transport = "public";
  } else if (peer.publicApiUrl) {
    throw new MeshClientError(
      `Peer "${peer.name}" is off the mesh and its public URL isn't HTTPS; refusing to send the call`,
      "INSECURE"
    );
  } else {
    throw new MeshClientError(`Peer "${peer.name}" unreachable via mesh and has no public URL`, "UNREACHABLE");
  }

  const body = JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...signMeshRequest({ token, method: "POST", path, body }),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MeshClientError(
      `Lost the connection to "${peer.name}" over the ${transport === "tunnel" ? "tunnel" : "public URL"} (${reason}); the call may have run`,
      "UNREACHABLE"
    );
  }

  if (!res.ok) {
    let message = `Peer returned ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {}
    throw new MeshClientError(message, "PEER_ERROR", res.status);
  }

  return { data: (await res.json()) as T, transport };
}

export class MeshClientError extends Error {
  constructor(
    message: string,
    public code:
      | "PEER_NOT_FOUND"
      | "NO_API_URL"
      | "NO_TOKEN"
      | "PEER_ERROR"
      | "UNREACHABLE"
      | "INSECURE",
    public statusCode?: number
  ) {
    super(message);
    this.name = "MeshClientError";
  }
}
