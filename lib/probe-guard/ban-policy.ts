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
  /** The admin's never-ban list. */
  allowlist?: readonly string[];
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
  if (ctx.allowlist?.length && cidrMatcher(ctx.allowlist)(ip)) return "on the allowlist";
  if (ctx.extraRanges?.length && cidrMatcher(ctx.extraRanges)(ip)) return "trusted proxy or linked instance";
  return null;
}

/** Address and prefix of an IP or CIDR, or null. A bare address gets its full length. */
export function parseCidr(raw: string): { addr: string; prefix: number; family: 4 | 6 } | null {
  const [rawAddr, prefixText, extra] = raw.trim().split("/");
  if (extra !== undefined) return null;
  const addr = normalizeIp(rawAddr);
  if (!addr) return null;
  const family = isIP(addr) as 4 | 6;
  const max = family === 4 ? 32 : 128;
  if (prefixText === undefined) return { addr, prefix: max, family };
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > max) return null;
  return { addr, prefix: Number(prefixText), family };
}

/** Whether two IPs or CIDRs share any address. CIDR blocks are nested or disjoint, so one holds the other's address. */
export function rangesOverlap(a: string, b: string): boolean {
  const pa = parseCidr(a);
  const pb = parseCidr(b);
  if (!pa || !pb || pa.family !== pb.family) return false;
  return cidrMatcher([a])(pb.addr) || cidrMatcher([b])(pa.addr);
}

/** Every range and address the context never bans. */
export function neverBanRanges(ctx: NeverBanContext = {}): string[] {
  return [
    ...NEVER_BAN_RANGES,
    ...CLOUDFLARE_IPV4_RANGES,
    ...CLOUDFLARE_IPV6_RANGES,
    ...(ctx.ownIps ?? []),
    ...(ctx.extraRanges ?? []),
    ...(ctx.allowlist ?? []),
  ].filter((r) => parseCidr(r));
}

/** Why a blocklist range can't be blocked, or null. Any overlap with a never-ban range refuses it. */
export function rangeNeverBanReason(range: string, ctx: NeverBanContext = {}, never = neverBanMatcher(ctx)): string | null {
  const parsed = parseCidr(range);
  if (!parsed) return "not an IP range";
  if (never.contains(parsed.addr)) return "overlaps a never-ban range";
  const inRange = cidrMatcher([range]);
  return never.addrs.some((a) => inRange(a)) ? "overlaps a never-ban range" : null;
}

/** The never-ban ranges as one matcher plus each range's own address, for overlap checks in bulk. */
export function neverBanMatcher(ctx: NeverBanContext = {}): { contains: (ip: string) => boolean; addrs: string[] } {
  const ranges = neverBanRanges(ctx);
  return { contains: cidrMatcher(ranges), addrs: ranges.map((r) => parseCidr(r)!.addr) };
}

/** Whether an address is one Vardo never bans: the same ranges and addresses `neverBanReason` checks. */
export function neverBanCheck(ctx: NeverBanContext = {}): (raw: string) => boolean {
  const contains = cidrMatcher(neverBanRanges(ctx));
  return (raw) => {
    const ip = normalizeIp(raw);
    return !!ip && contains(ip);
  };
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

/** How long ban rows and probe events are kept, for the Security page's ranges. */
export const RETENTION_MS = 90 * 24 * 3_600_000;

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

type RenderRow = { ip: string; expiresAt: Date; createdAt: Date; reason?: string; hits?: number };

function renderRank(r: RenderRow): number {
  if (isPermanent(r.expiresAt)) return 0;
  return r.reason === "blocklist" ? 2 : 1;
}

/**
 * Guard file order, one entry per address: permanent bans, then the newest local ones, then blocklist
 * bans by confidence. Blocklist bans take at most `maxBlocklist` slots.
 */
export function banRenderOrder(rows: readonly RenderRow[], max: number, maxBlocklist = max): string[] {
  const sorted = [...rows].sort((a, b) => {
    const rank = renderRank(a) - renderRank(b);
    if (rank !== 0) return rank;
    if (renderRank(a) === 2 && (b.hits ?? 0) !== (a.hits ?? 0)) return (b.hits ?? 0) - (a.hits ?? 0);
    return b.createdAt.getTime() - a.createdAt.getTime() || (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0);
  });
  const out: string[] = [];
  const seen = new Set<string>();
  let blocklist = 0;
  for (const r of sorted) {
    if (out.length >= max) break;
    if (seen.has(r.ip)) continue;
    if (renderRank(r) === 2) {
      if (blocklist >= maxBlocklist) continue;
      blocklist++;
    }
    seen.add(r.ip);
    out.push(r.ip);
  }
  return out;
}

/** Whether pruning may drop a ban: temporary ones past retention. Permanent bans are kept. */
export function isPrunable(ban: { expiresAt: Date }, now: Date): boolean {
  return !isPermanent(ban.expiresAt) && ban.expiresAt.getTime() < now.getTime() - RETENTION_MS;
}
