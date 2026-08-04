// ---------------------------------------------------------------------------
// Outbound URL policy
//
// Webhooks, url-type cron jobs and hook callbacks all fetch a URL somebody
// typed into a form. Without a check that reaches the cloud metadata service
// and every host on the internal network — a boundary the person setting the
// URL has no account on.
//
// Addresses are judged after DNS resolution, so decimal, octal and hex host
// encodings (http://2130706433/) need no special handling: they resolve to the
// address they always meant, and the address is what gets checked.
// ---------------------------------------------------------------------------

import { lookup } from "dns/promises";

/** An outbound request that policy refuses to make. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

/** Parse dotted-quad IPv4 into 4 bytes, or null if it is not one. */
export function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/**
 * Parse IPv6 into 16 bytes, expanding `::`. Returns null if it is not one.
 *
 * IPv4-mapped and NAT64 forms keep their trailing dotted quad, which lands in
 * the last four bytes — exactly where the mapped-address check looks for it.
 */
export function parseIPv6(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (part === "") return [];
    const bytes: number[] = [];
    for (const group of part.split(":")) {
      const quad = parseIPv4(group);
      if (quad) {
        bytes.push(...quad);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const n = Number.parseInt(group, 16);
      bytes.push((n >> 8) & 0xff, n & 0xff);
    }
    return bytes;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 16 ? head : null;

  const gap = 16 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...new Array(gap).fill(0), ...tail];
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** [first byte(s), prefix length, why] — IPv4 ranges that must not be reached. */
const BLOCKED_V4: { cidr: string; reason: string }[] = [
  { cidr: "0.0.0.0/8", reason: "this network" },
  { cidr: "10.0.0.0/8", reason: "private network" },
  { cidr: "100.64.0.0/10", reason: "carrier-grade NAT (Tailscale)" },
  { cidr: "127.0.0.0/8", reason: "loopback" },
  { cidr: "169.254.0.0/16", reason: "link-local — cloud instance metadata" },
  { cidr: "172.16.0.0/12", reason: "private network" },
  { cidr: "192.0.0.0/24", reason: "IETF protocol assignments" },
  { cidr: "192.0.2.0/24", reason: "documentation range" },
  { cidr: "192.168.0.0/16", reason: "private network" },
  { cidr: "198.18.0.0/15", reason: "benchmarking range" },
  { cidr: "198.51.100.0/24", reason: "documentation range" },
  { cidr: "203.0.113.0/24", reason: "documentation range" },
  { cidr: "224.0.0.0/4", reason: "multicast" },
  { cidr: "240.0.0.0/4", reason: "reserved" },
];

const BLOCKED_V6: { cidr: string; reason: string }[] = [
  { cidr: "::/128", reason: "unspecified address" },
  { cidr: "::1/128", reason: "loopback" },
  { cidr: "fc00::/7", reason: "unique local address" },
  { cidr: "fe80::/10", reason: "link-local" },
  { cidr: "ff00::/8", reason: "multicast" },
  { cidr: "2001:db8::/32", reason: "documentation range" },
];

function bytesFromCidr(cidr: string): { bytes: number[]; bits: number } {
  const [addr, len] = cidr.split("/");
  const bytes = addr.includes(":") ? parseIPv6(addr) : parseIPv4(addr);
  return { bytes: bytes ?? [], bits: Number(len) };
}

const V4_RULES = BLOCKED_V4.map((r) => ({ ...r, ...bytesFromCidr(r.cidr) }));
const V6_RULES = BLOCKED_V6.map((r) => ({ ...r, ...bytesFromCidr(r.cidr) }));

/** Whether `bytes` falls inside the network described by `net`/`bits`. */
export function inRange(bytes: number[], net: number[], bits: number): boolean {
  if (bytes.length !== net.length) return false;
  let remaining = bits;
  for (let i = 0; i < bytes.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((bytes[i] & mask) !== (net[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

// Full 16 bytes — inRange compares equal-length arrays, and only the first 96
// bits are examined. The trailing zeros are padding, not part of the prefix.
const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0];
const NAT64_PREFIX = [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Why this address is refused, or null when it may be reached.
 *
 * IPv4-mapped (`::ffff:169.254.169.254`) and NAT64 forms are unwrapped and
 * judged as the IPv4 address they carry. Skipping that unwrap is the standard
 * way these filters get walked through.
 */
export function blockedAddressReason(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4) {
    for (const rule of V4_RULES) {
      if (inRange(v4, rule.bytes, rule.bits)) return rule.reason;
    }
    return null;
  }

  const v6 = parseIPv6(address);
  if (!v6) return "unrecognized address format";

  if (inRange(v6, V4_MAPPED_PREFIX, 96) || inRange(v6, NAT64_PREFIX, 96)) {
    return blockedAddressReason(v6.slice(12).join("."));
  }

  for (const rule of V6_RULES) {
    if (inRange(v6, rule.bytes, rule.bits)) return rule.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL checking
// ---------------------------------------------------------------------------

export type OutboundPolicy = {
  /**
   * Hostnames permitted to resolve into a blocked range. Exact match, or a
   * leading "." for a suffix match. For deliberately reaching an internal
   * service, which is a legitimate thing to want on a homelab.
   */
  allowlist?: string[];
};

function isAllowlisted(hostname: string, allowlist: string[] | undefined): boolean {
  if (!allowlist?.length) return false;
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith(".") ? host === e.slice(1) || host.endsWith(e) : host === e;
  });
}

/**
 * Parse and vet a URL for an outbound request.
 *
 * Throws BlockedUrlError for a non-HTTP scheme, a host that will not resolve,
 * or any resolved address inside a blocked range. **Every** address the host
 * resolves to is checked — a name with one public and one private record
 * cannot be used to slip past a first-record-only check.
 */
export async function assertOutboundUrlAllowed(
  raw: string,
  policy: OutboundPolicy = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(
      `Refusing ${url.protocol} — only http and https may be requested`,
    );
  }

  if (isAllowlisted(url.hostname, policy.allowlist)) return url;

  // A bare address needs no lookup, and passing one to the resolver would only
  // add a way for it to answer differently.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (parseIPv4(literal) || parseIPv6(literal)) {
    const reason = blockedAddressReason(literal);
    if (reason) {
      throw new BlockedUrlError(`Refusing to reach ${literal} — ${reason}`);
    }
    return url;
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(url.hostname, { all: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${url.hostname}`);
  }

  if (resolved.length === 0) {
    throw new BlockedUrlError(`${url.hostname} resolved to no addresses`);
  }

  for (const { address } of resolved) {
    const reason = blockedAddressReason(address);
    if (reason) {
      throw new BlockedUrlError(
        `Refusing to reach ${url.hostname} — it resolves to ${address} (${reason})`,
      );
    }
  }

  return url;
}
