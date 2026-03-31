import { promises as dns } from "dns";
import { isIP } from "net";

/**
 * Private / link-local / loopback IP ranges that must never be contacted
 * during an outbound security scan (SSRF protection).
 */
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

/**
 * Validate that a domain is safe to contact from the scanner.
 *
 * Rejects:
 * - Loopback hostnames (localhost, ::1)
 * - Private / link-local IP literals (10.x, 172.16-31.x, 192.168.x, 169.254.x, …)
 * - Domains that resolve via DNS to any private IP
 *
 * Throws an Error if the domain should be blocked. Does nothing if safe.
 */
export async function assertPublicDomain(domain: string): Promise<void> {
  // If the input is already a bare IP (including IPv6), use it directly.
  // Otherwise strip the port suffix from "hostname:port" or "1.2.3.4:port".
  // Note: IPv6 literals contain colons, so split(":")[0] would mangle them —
  // hence the isIP check first.
  const host = isIP(domain) !== 0
    ? domain.toLowerCase()
    : domain.split(":")[0].toLowerCase();

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error(`SSRF: blocked hostname "${host}"`);
  }

  // If the domain is already an IP literal, check it directly.
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(`SSRF: blocked private IP "${host}"`);
    }
    return;
  }

  // Resolve the domain and check all returned addresses.
  const v4 = await dns.resolve4(host).catch(() => [] as string[]);
  const v6 = await dns.resolve6(host).catch(() => [] as string[]);

  for (const ip of [...v4, ...v6]) {
    if (isPrivateIp(ip)) {
      throw new Error(`SSRF: domain "${host}" resolves to private IP "${ip}"`);
    }
  }
}
