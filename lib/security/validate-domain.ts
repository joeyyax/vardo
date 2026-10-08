import { promises as dns } from "dns";
import { isIP } from "net";
import { blockedAddressReason } from "./ssrf";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

/** Same ranges as outbound requests, including CGNAT and IPv4-mapped IPv6. */
function isPrivateIp(ip: string): boolean {
  return blockedAddressReason(ip) !== null;
}

/** Throws if a domain is loopback, a private IP or resolves to one. */
export async function assertPublicDomain(domain: string): Promise<void> {
  // Check isIP first: splitting an IPv6 literal on ":" would mangle it.
  const host = isIP(domain) !== 0
    ? domain.toLowerCase()
    : domain.split(":")[0].toLowerCase();

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error(`SSRF: blocked hostname "${host}"`);
  }

  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(`SSRF: blocked private IP "${host}"`);
    }
    return;
  }

  // Check every resolved address.
  const v4 = await dns.resolve4(host).catch(() => [] as string[]);
  const v6 = await dns.resolve6(host).catch(() => [] as string[]);

  for (const ip of [...v4, ...v6]) {
    if (isPrivateIp(ip)) {
      throw new Error(`SSRF: domain "${host}" resolves to private IP "${ip}"`);
    }
  }
}
