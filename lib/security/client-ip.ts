// The client address a request is keyed by. X-Forwarded-For counts only when the TCP peer is Traefik (#889).
// CF-Connecting-IP counts only when Traefik's own peer was a Cloudflare edge, a cloudflared tunnel or VARDO_TRUSTED_PROXIES (#902).

import { isIP } from "net";
import { cidrMatcher, cloudflareTrustEnabled, trustedProxyRanges } from "@/lib/cloudflare-ips";
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
  isCloudflareProxy: (ip: string) => boolean = () => false,
): string {
  const raw = headers.get(PEER_HEADER);
  if (!raw) return forwardedIp(headers) ?? "unknown";
  const peer = normalize(raw);
  if (!isProxy(peer)) return peer;
  const hop = traefikPeer(headers);
  if (!hop) return peer;
  if (isCloudflareProxy(hop)) return cfConnectingIp(headers) ?? hop;
  return hop;
}

type DockerNetworks = Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;

const CLOUDFLARED_IMAGE = /^(?:(?:docker\.io|registry-1\.docker\.io)\/)?cloudflare\/cloudflared(?:[:@]|$)/;

/** Addresses of cloudflared containers on the networks Traefik is on. */
export function tunnelAddresses(containers: unknown, traefikNetworks: ReadonlySet<string>): Set<string> {
  const ips = new Set<string>();
  if (!Array.isArray(containers)) return ips;
  for (const c of containers as { Image?: string; NetworkSettings?: { Networks?: DockerNetworks } }[]) {
    if (!CLOUDFLARED_IMAGE.test(c.Image ?? "")) continue;
    for (const [name, net] of Object.entries(c.NetworkSettings?.Networks ?? {})) {
      if (!traefikNetworks.has(name)) continue;
      if (net.IPAddress) ips.add(net.IPAddress);
      if (net.GlobalIPv6Address) ips.add(net.GlobalIPv6Address);
    }
  }
  return ips;
}

const EDGE_TTL_MS = 10 * 60_000;
let edges = { cloudflare: cidrMatcher([...BUNDLED_RANGES.v4, ...BUNDLED_RANGES.v6]), tunnels: new Set<string>(), at: 0, tunnelsAt: 0 };
let manual = { source: "", match: cidrMatcher([]) };

async function loadTunnels(): Promise<Set<string>> {
  try {
    const running = await dockerRequest<unknown>("GET", `/containers/json?filters=${encodeURIComponent(JSON.stringify({ status: ["running"] }))}`);
    return tunnelAddresses(running, cache.networks);
  } catch {
    return new Set();
  }
}

/** Hops whose CF-Connecting-IP is trusted. Ranges and tunnels refresh together; a miss refreshes tunnels, but no more often than MISS_REFRESH_MS. */
async function cloudflareProxies(opts: { refresh?: boolean } = {}): Promise<(ip: string) => boolean> {
  const source = process.env.VARDO_TRUSTED_PROXIES ?? "";
  if (source !== manual.source) manual = { source, match: cidrMatcher(trustedProxyRanges()) };
  const listed = manual.match;
  if (!cloudflareTrustEnabled()) return listed;

  const now = Date.now();
  if (now - edges.at >= EDGE_TTL_MS) {
    edges = { cloudflare: cidrMatcher(await currentCloudflareRanges()), tunnels: await loadTunnels(), at: now, tunnelsAt: now };
  } else if (opts.refresh && now - edges.tunnelsAt >= MISS_REFRESH_MS) {
    edges = { ...edges, tunnels: await loadTunnels(), tunnelsAt: now };
  }
  const { cloudflare, tunnels } = edges;
  return (ip) => listed(ip) || cloudflare(ip) || tunnels.has(normalize(ip));
}

type Cache = { ips: Set<string>; networks: Set<string>; at: number };
let cache: Cache = { ips: new Set(), networks: new Set(), at: 0 };

/** Addresses of the Traefik container, from Docker rather than DNS, which any app on vardo-network could answer for. */
export async function traefikAddresses(opts: { refresh?: boolean } = {}): Promise<Set<string>> {
  const age = Date.now() - cache.at;
  if (age < TTL_MS && !(opts.refresh && age >= MISS_REFRESH_MS)) return cache.ips;
  const name = process.env.VARDO_TRAEFIK_CONTAINER || "vardo-traefik";
  try {
    const info = await dockerRequest<{
      NetworkSettings?: { Networks?: DockerNetworks };
    }>("GET", `/containers/${encodeURIComponent(name)}/json`);
    const ips = new Set<string>();
    const networks = info.NetworkSettings?.Networks ?? {};
    for (const net of Object.values(networks)) {
      if (net.IPAddress) ips.add(net.IPAddress);
      if (net.GlobalIPv6Address) ips.add(net.GlobalIPv6Address);
    }
    cache = { ips, networks: new Set(Object.keys(networks)), at: Date.now() };
  } catch {
    // Nothing is trusted until Docker answers.
    cache = { ips: new Set(), networks: new Set(), at: Date.now() };
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
  const isProxy = (ip: string) => ips.has(ip);
  let proxies = await cloudflareProxies();
  // A recreated cloudflared has a new address until the next refresh.
  const hop = traefikPeer(headers);
  if (isProxy(peer) && hop && !proxies(hop) && headers.has("cf-connecting-ip")) proxies = await cloudflareProxies({ refresh: true });
  return resolveClientIp(headers, isProxy, proxies);
}
