// The client address a request is keyed by. X-Forwarded-For counts only when the TCP peer is Traefik (#889).
// CF-Connecting-IP counts only when Traefik's own peer was a Cloudflare edge (#902).

import { isIP } from "net";
import { cidrMatcher, cloudflareTrustEnabled } from "@/lib/cloudflare-ips";
import { dockerRequest } from "@/lib/docker/client";
import { BUNDLED_RANGES, currentCloudflareRanges } from "@/lib/docker/cloudflare-only";

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

/** The last X-Forwarded-For entry: the address Traefik appended for its own peer. */
function traefikPeer(headers: Headers): string | null {
  const hops = headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  const last = hops.at(-1) ?? headers.get("x-real-ip")?.trim();
  return last ? normalize(last) : null;
}

function cfConnectingIp(headers: Headers): string | null {
  const value = headers.get("cf-connecting-ip");
  if (!value) return null;
  const ip = normalize(value);
  return isIP(ip) ? ip : null;
}

/** The address to key a request by. Without a peer header (dev, no preload) the forwarded headers are all there is. */
export function resolveClientIp(
  headers: Headers,
  isProxy: (ip: string) => boolean,
  isCloudflare: (ip: string) => boolean = () => false,
): string {
  const raw = headers.get(PEER_HEADER);
  if (!raw) return forwardedIp(headers) ?? "unknown";
  const peer = normalize(raw);
  if (!isProxy(peer)) return peer;
  const hop = traefikPeer(headers);
  if (!hop) return peer;
  if (isCloudflare(hop)) return cfConnectingIp(headers) ?? hop;
  return hop;
}

const CLOUDFLARE_TTL_MS = 10 * 60_000;
let cloudflare = { match: cidrMatcher([...BUNDLED_RANGES.v4, ...BUNDLED_RANGES.v6]), at: 0 };

/** Cloudflare's ranges as the middleware file has them, re-read every few minutes. */
async function cloudflareMatcher(): Promise<(ip: string) => boolean> {
  if (!cloudflareTrustEnabled()) return () => false;
  if (Date.now() - cloudflare.at >= CLOUDFLARE_TTL_MS) {
    cloudflare = { match: cidrMatcher(await currentCloudflareRanges()), at: Date.now() };
  }
  return cloudflare.match;
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
  return resolveClientIp(headers, (ip) => ips.has(ip), await cloudflareMatcher());
}
