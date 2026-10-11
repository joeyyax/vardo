// Who may be banned, when and for how long.

import { isIP } from "net";
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES, cidrMatcher } from "@/lib/cloudflare-ips";
import type { InstanceProbeGuard } from "./settings";
import { isPermanent } from "./permanent";

// Private, loopback, link-local, CGNAT (Tailscale), multicast and unspecified ranges. The mesh sits in 10/8.
export const NEVER_BAN_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "255.255.255.255/32",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "fd7a:115c:a1e0::/48",
];

const fixed = cidrMatcher(NEVER_BAN_RANGES);
const cloudflare = cidrMatcher([...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]);

export type NeverBanContext = {
  /** This instance's own public addresses. */
  ownIps?: readonly string[];
  /** Trusted proxies, linked instances and anything else to leave alone. */
  extraRanges?: readonly string[];
};

/** The bare address an IP string normalizes to, or null when it isn't one. */
export function normalizeIp(raw: string): string | null {
  const ip = raw.trim().replace(/^::ffff:(?=\d+\.)/i, "").toLowerCase();
  return isIP(ip) ? ip : null;
}

/** Why an address must never be banned, or null when it may be. */
export function neverBanReason(raw: string, ctx: NeverBanContext = {}): string | null {
  const ip = normalizeIp(raw);
  if (!ip) return "not an IP address";
  if (fixed(ip)) return "private or reserved range";
  if (cloudflare(ip)) return "Cloudflare edge";
  if (ctx.ownIps?.some((o) => normalizeIp(o) === ip)) return "this instance";
  if (ctx.extraRanges?.length && cidrMatcher(ctx.extraRanges)(ip)) return "trusted proxy or linked instance";
  return null;
}

/** Ban length for an address with `priorBans` recent bans: doubling from the base, capped. */
export function banDurationMs(priorBans: number, settings: Pick<InstanceProbeGuard, "banMinutes" | "maxBanHours">): number {
  const base = settings.banMinutes * 60_000;
  const max = settings.maxBanHours * 3_600_000;
  const doublings = Math.min(Math.max(0, priorBans), 20);
  return Math.min(base * 2 ** doublings, max);
}

/** How far back earlier bans count toward doubling. */
export const REPEAT_LOOKBACK_MS = 30 * 24 * 3_600_000;

/** Sliding-window check: hit timestamps within the window, threshold reached. */
export function windowHits(timestamps: readonly number[], now: number, windowMs: number): number {
  return timestamps.filter((t) => t > now - windowMs && t <= now).length;
}

export function reachesThreshold(hits: number, settings: Pick<InstanceProbeGuard, "threshold">): boolean {
  return hits >= settings.threshold;
}

/** Remote bans apply with the remote's expiry, but never longer than the local maximum. */
export function remoteBanExpiry(remote: Date, now: Date, settings: Pick<InstanceProbeGuard, "maxBanHours">): Date | null {
  const cap = now.getTime() + settings.maxBanHours * 3_600_000;
  const at = Math.min(remote.getTime(), cap);
  return at > now.getTime() ? new Date(at) : null;
}

/** Guard file order: permanent bans first, then the newest temporary ones, one entry per address. */
export function banRenderOrder(rows: readonly { ip: string; expiresAt: Date; createdAt: Date }[], max: number): string[] {
  const sorted = [...rows].sort((a, b) => {
    const p = Number(isPermanent(b.expiresAt)) - Number(isPermanent(a.expiresAt));
    return p !== 0 ? p : b.createdAt.getTime() - a.createdAt.getTime();
  });
  return [...new Set(sorted.map((r) => r.ip))].slice(0, max);
}

/** Whether pruning may drop a ban. Permanent bans are kept, lifted or not. */
export function isPrunable(ban: { expiresAt: Date }, now: Date): boolean {
  return !isPermanent(ban.expiresAt) && ban.expiresAt.getTime() < now.getTime() - REPEAT_LOOKBACK_MS;
}
