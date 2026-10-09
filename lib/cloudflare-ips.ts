import { BlockList, isIP } from "net";

/**
 * Cloudflare IPv4 CIDR ranges.
 * Source: https://www.cloudflare.com/ips-v4
 * Last updated: 2026-10-08
 */
export const CLOUDFLARE_IPV4_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

/**
 * Cloudflare IPv6 CIDR ranges.
 * Source: https://www.cloudflare.com/ips-v6
 * Last updated: 2026-10-08
 */
export const CLOUDFLARE_IPV6_RANGES = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** Parse a CIDR string into a numeric base address and mask. */
function parseCidr(cidr: string): { base: number; mask: number } {
  const [ip, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr, 10);
  const parts = ip.split(".").map(Number);
  const base = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base, mask };
}

const parsedRanges = CLOUDFLARE_IPV4_RANGES.map(parseCidr);

function ipToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Whether an IPv4 address is in a Cloudflare range. */
export function isCloudflareIp(ip: string): boolean {
  const num = ipToNum(ip);
  return parsedRanges.some(({ base, mask }) => (num & mask) === base);
}

/** Matches IPv4 and IPv6 addresses, IPv4-mapped included, against a list of CIDRs. */
export function cidrMatcher(ranges: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const range of ranges) {
    const [addr, prefix] = range.split("/");
    const family = isIP(addr);
    if (family && prefix) list.addSubnet(addr, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }
  return (ip) => {
    const addr = ip.trim().replace(/^::ffff:(?=\d+\.)/i, "");
    const family = isIP(addr);
    return family !== 0 && list.check(addr, family === 4 ? "ipv4" : "ipv6");
  };
}

/** False when VARDO_TRUST_CLOUDFLARE opts the host out of trusting Cloudflare's forwarded headers. */
export function cloudflareTrustEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.VARDO_TRUST_CLOUDFLARE?.trim().toLowerCase();
  return value !== "false" && value !== "0";
}
