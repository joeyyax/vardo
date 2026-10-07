import { promises as dns } from "dns";
import { isIP } from "net";

/** IP ranges the scanner must never contact. */
const PRIVATE_IP_PATTERNS = [
  /^127\./,           // 127.0.0.0/8  loopback
  /^10\./,            // 10.0.0.0/8   private
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 private
  /^192\.168\./,      // 192.168.0.0/16 private
  /^169\.254\./,      // 169.254.0.0/16 link-local / AWS metadata
  /^0\./,             // 0.0.0.0/8
  /^::1$/,            // IPv6 loopback
  /^fc[0-9a-f]{2}:/i, // IPv6 ULA fc00::/7
  /^fd[0-9a-f]{2}:/i, // IPv6 ULA fd00::/8
  /^fe80:/i,          // IPv6 link-local
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some((r) => r.test(ip));
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
