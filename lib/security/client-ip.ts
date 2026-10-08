// The client address a request is keyed by. X-Forwarded-For counts only when the TCP peer is Traefik (#889).

import { dockerRequest } from "@/lib/docker/client";

/** Set from the socket by scripts/peer-address.mjs, overwriting any client-sent value. */
export const PEER_HEADER = "x-vardo-peer";

const TTL_MS = 30_000;
// A recreated Traefik gets a new address; a miss refreshes, but no more often than this.
const MISS_REFRESH_MS = 5_000;

function normalize(ip: string): string {
  return ip.trim().replace(/^::ffff:/i, "");
}

function forwardedIp(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || null;
}

/** The address to key a request by. Without a peer header (dev, no preload) the forwarded headers are all there is. */
export function resolveClientIp(headers: Headers, isProxy: (ip: string) => boolean): string {
  const raw = headers.get(PEER_HEADER);
  if (!raw) return forwardedIp(headers) ?? "unknown";
  const peer = normalize(raw);
  if (!isProxy(peer)) return peer;
  return forwardedIp(headers) ?? peer;
}

type Cache = { ips: Set<string>; at: number };
let cache: Cache = { ips: new Set(), at: 0 };

/** Addresses of the Traefik container, from Docker rather than DNS, which any app on vardo-network could answer for. */
export async function traefikAddresses(opts: { refresh?: boolean } = {}): Promise<Set<string>> {
  const age = Date.now() - cache.at;
  if (age < TTL_MS && !(opts.refresh && age >= MISS_REFRESH_MS)) return cache.ips;
  const name = process.env.VARDO_TRAEFIK_CONTAINER || "vardo-traefik";
  try {
    const info = await dockerRequest<{
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }> };
    }>("GET", `/containers/${encodeURIComponent(name)}/json`);
    const ips = new Set<string>();
    for (const net of Object.values(info.NetworkSettings?.Networks ?? {})) {
      if (net.IPAddress) ips.add(net.IPAddress);
      if (net.GlobalIPv6Address) ips.add(net.GlobalIPv6Address);
    }
    cache = { ips, at: Date.now() };
  } catch {
    // Nothing is trusted until Docker answers.
    cache = { ips: new Set(), at: Date.now() };
  }
  return cache.ips;
}

/** Client address for a request, checking the peer against Traefik's live addresses. */
export async function clientIpFor(headers: Headers): Promise<string> {
  const raw = headers.get(PEER_HEADER);
  if (!raw) return resolveClientIp(headers, () => false);
  const peer = normalize(raw);
  let ips = await traefikAddresses();
  if (!ips.has(peer)) ips = await traefikAddresses({ refresh: true });
  return resolveClientIp(headers, (ip) => ips.has(ip));
}
