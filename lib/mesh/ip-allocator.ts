/**
 * WireGuard tunnel IP allocator.
 *
 * Uses a /24 subnet (default 10.99.0.0/24) for the mesh.
 * Hub gets .1, peers are assigned sequentially from .2.
 */

const DEFAULT_SUBNET = "10.99.0";

export const HUB_IP = `${DEFAULT_SUBNET}.1`;

/** Find the next available IP given a list of already-assigned IPs. */
export function allocateIp(assignedIps: string[]): string {
  const used = new Set(
    assignedIps.map((ip) => {
      const parts = ip.split(".");
      return parseInt(parts[3], 10);
    })
  );

  // Start from .2 (hub is .1)
  for (let octet = 2; octet <= 254; octet++) {
    if (!used.has(octet)) {
      return `${DEFAULT_SUBNET}.${octet}`;
    }
  }

  throw new Error("No available IPs in mesh subnet — 253 peers maximum");
}
