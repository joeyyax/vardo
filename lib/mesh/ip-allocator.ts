/**
 * WireGuard tunnel IP allocator.
 *
 * Uses a /24 subnet (default 10.99.0.0/24) for the mesh.
 * Hub gets .1, peers are assigned sequentially from .2.
 * All returned IPs include /32 CIDR notation for WireGuard AllowedIPs.
 */

const DEFAULT_SUBNET = "10.99.0";
const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/;

export const HUB_IP = `${DEFAULT_SUBNET}.1`;
export const HUB_CIDR = `${HUB_IP}/32`;

/** Extract the last octet from an IP (with or without CIDR suffix). */
function lastOctet(ip: string): number {
  const bare = ip.split("/")[0];
  if (!IP_RE.test(bare)) {
    throw new Error(`Invalid IP address: ${ip}`);
  }
  const parts = bare.split(".");
  const octet = parseInt(parts[3], 10);
  if (isNaN(octet) || octet < 0 || octet > 255) {
    throw new Error(`Invalid IP address: ${ip}`);
  }
  return octet;
}

/** Find the next available IP given a list of already-assigned IPs. Returns CIDR (/32). */
export function allocateIp(assignedIps: string[]): string {
  const used = new Set(assignedIps.map(lastOctet));

  // Start from .2 (hub is .1)
  for (let octet = 2; octet <= 254; octet++) {
    if (!used.has(octet)) {
      return `${DEFAULT_SUBNET}.${octet}`;
    }
  }

  throw new Error("No available IPs in mesh subnet — 253 peers maximum");
}

/** Format an IP as a /32 CIDR for WireGuard AllowedIPs. */
export function toCidr(ip: string): string {
  const bare = ip.split("/")[0];
  return `${bare}/32`;
}
