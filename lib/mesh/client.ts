import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Make an authenticated request to a mesh peer's API.
 *
 * Tries the WireGuard mesh URL first (fast, encrypted tunnel). If unreachable,
 * falls back to the peer's public API URL (works before tunnel routing is set up
 * or when the mesh is down).
 */
export async function meshFetch(
  peerId: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
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

  const authHeaders = {
    ...options.headers,
    Authorization: `Bearer ${peer.outboundToken}`,
  };

  // Try mesh URL first (WireGuard tunnel) with a short timeout
  if (peer.apiUrl) {
    try {
      const res = await fetch(`${peer.apiUrl}${path}`, {
        ...options,
        headers: authHeaders,
        signal: AbortSignal.timeout(5_000),
      });
      return res;
    } catch {
      // Mesh unreachable — fall through to public URL
    }
  }

  // Fall back to public API URL
  if (peer.publicApiUrl) {
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
