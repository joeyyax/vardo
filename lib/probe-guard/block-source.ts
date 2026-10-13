// Which ban or blocklist range turned a request away.

import { isIP } from "net";
import { normalizeIp, parseCidr } from "./ban-policy";

export const BLOCK_SOURCES = ["local", "abuseipdb", "spamhaus"] as const;
/** `other` is a block Traefik made that no current ban or range explains, such as a ban lifted since. */
export type BlockSource = (typeof BLOCK_SOURCES)[number] | "other";

export type BlockMatch = { source: BlockSource; banId?: string; range?: string };
export type BanRef = { id: string; blocklist: boolean; expiresAt: Date };

function v4Value(addr: string): bigint | null {
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return BigInt(((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]);
}

function v6Value(addr: string): bigint | null {
  let text = addr.toLowerCase();
  const tail4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail4) {
    const n = v4Value(tail4[1]);
    if (n === null) return null;
    text = `${text.slice(0, -tail4[1].length)}${(n >> BigInt(16)).toString(16)}:${(n & BigInt(0xffff)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  let out = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return out;
}

function addressValue(addr: string, family: 4 | 6): bigint | null {
  return family === 4 ? v4Value(addr) : v6Value(addr);
}

/** Finds the listed range an address falls in, most specific first, or null. */
export function rangeFinder(ranges: readonly string[]): (ip: string) => string | null {
  const groups = new Map<string, { family: 4 | 6; shift: bigint; prefix: number; nets: Map<bigint, string> }>();
  for (const range of ranges) {
    const parsed = parseCidr(range);
    if (!parsed) continue;
    const value = addressValue(parsed.addr, parsed.family);
    if (value === null) continue;
    const key = `${parsed.family}/${parsed.prefix}`;
    let group = groups.get(key);
    if (!group) {
      group = { family: parsed.family, prefix: parsed.prefix, shift: BigInt((parsed.family === 4 ? 32 : 128) - parsed.prefix), nets: new Map() };
      groups.set(key, group);
    }
    const net = value >> group.shift;
    if (!group.nets.has(net)) group.nets.set(net, range);
  }
  const ordered = [...groups.values()].sort((a, b) => b.prefix - a.prefix);
  return (raw) => {
    const ip = normalizeIp(raw);
    if (!ip) return null;
    const family = isIP(ip) as 4 | 6;
    const value = addressValue(ip, family);
    if (value === null) return null;
    for (const g of ordered) {
      if (g.family !== family) continue;
      const hit = g.nets.get(value >> g.shift);
      if (hit) return hit;
    }
    return null;
  };
}

/** A ban on any candidate address wins over a range. Candidates are the client and the peer Traefik saw. */
export function attributeBlock(
  candidates: readonly string[],
  banFor: (ip: string) => BanRef | undefined,
  rangeFor: (ip: string) => string | null,
): BlockMatch {
  const ips = [...new Set(candidates.map(normalizeIp).filter((ip): ip is string => !!ip))];
  for (const ip of ips) {
    const ban = banFor(ip);
    if (ban) return { source: ban.blocklist ? "abuseipdb" : "local", banId: ban.id };
  }
  for (const ip of ips) {
    const range = rangeFor(ip);
    if (range) return { source: "spamhaus", range };
  }
  return { source: "other" };
}
