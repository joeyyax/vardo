// Last tunnel failure per peer, so a fallback to the public URL is visible.

import { logger } from "@/lib/logger";

const log = logger.child("mesh-tunnel");

export type TunnelFailure = { error: string; since: string };

// On globalThis: route handlers and schedulers load separate copies of this module.
const globalForTunnel = globalThis as unknown as { __vardo_tunnel_failures?: Map<string, TunnelFailure> };

function failures(): Map<string, TunnelFailure> {
  globalForTunnel.__vardo_tunnel_failures ??= new Map();
  return globalForTunnel.__vardo_tunnel_failures;
}

/** Error text for a failed fetch, with the socket error code fetch hides in `cause`. */
export function describeTunnelError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timed out";
  const cause = err.cause as { code?: string; message?: string } | undefined;
  return cause?.code ?? cause?.message ?? err.message;
}

export function recordTunnelFailure(peerId: string, peerName: string, apiUrl: string, err: unknown): void {
  const error = `${apiUrl} unreachable over the tunnel (${describeTunnelError(err)})`;
  const prev = failures().get(peerId);
  if (prev?.error === error) return;
  failures().set(peerId, { error, since: prev?.since ?? new Date().toISOString() });
  log.warn(`Peer "${peerName}": ${error}; falling back to its public URL. Check its WireGuard console forward.`);
}

export function recordTunnelOk(peerId: string, peerName: string): void {
  if (!failures().delete(peerId)) return;
  log.info(`Peer "${peerName}": tunnel reachable again`);
}

export function tunnelFailure(peerId: string): TunnelFailure | null {
  return failures().get(peerId) ?? null;
}
