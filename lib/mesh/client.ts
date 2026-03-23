import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Make an authenticated request to a mesh peer's API over WireGuard.
 *
 * Resolves the peer's apiUrl and outbound token from the database,
 * then makes a fetch call with Bearer auth.
 */
export async function meshFetch(
  peerId: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const peer = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.id, peerId),
    columns: { apiUrl: true, outboundToken: true, name: true, status: true },
  });

  if (!peer) {
    throw new MeshClientError(`Peer not found: ${peerId}`, "PEER_NOT_FOUND");
  }

  if (!peer.apiUrl) {
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

  const url = `${peer.apiUrl}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${peer.outboundToken}`,
    },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });

  return res;
}

/**
 * Convenience wrapper — makes a JSON request and parses the response.
 * Throws on non-2xx responses with the error message from the peer.
 */
export async function meshJsonFetch<T = unknown>(
  peerId: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await meshFetch(peerId, path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

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

export class MeshClientError extends Error {
  constructor(
    message: string,
    public code:
      | "PEER_NOT_FOUND"
      | "NO_API_URL"
      | "NO_TOKEN"
      | "PEER_ERROR"
      | "UNREACHABLE",
    public statusCode?: number
  ) {
    super(message);
    this.name = "MeshClientError";
  }
}
