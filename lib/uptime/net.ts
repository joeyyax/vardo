// Tells public hosts from private ones, so checks from linked instances take the public path and never the tunnel.

import { lookup } from "node:dns/promises";
import net from "node:net";
import { HUB_IP } from "@/lib/mesh/ip-allocator";
import { checkHost, isInternalName, isPrivateAddress, type Check, type Cidr, type IntervalSec, type WatchEntry } from "./core";

/** The mesh /24, on top of the private ranges. */
const MESH_RANGE: Cidr = [`${HUB_IP.split(".").slice(0, 3).join(".")}.0`, 24];

export type HostClass = "public" | "private" | "unresolved";

export type Resolver = (host: string) => Promise<string[]>;

const resolveAll: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export const isPrivateOrMesh = (address: string) => isPrivateAddress(address, [MESH_RANGE]);

/** Private when the host is an internal name or any address it resolves to is private. Unresolved when no lookup answers. */
export async function classifyHost(host: string, resolve: Resolver = resolveAll): Promise<HostClass> {
  if (!host || isInternalName(host)) return "private";
  if (/^[\d.]+$/.test(host) || host.includes(":")) return isPrivateOrMesh(host) ? "private" : "public";
  try {
    const addresses = await resolve(host);
    if (addresses.length === 0) return "unresolved";
    return addresses.some(isPrivateOrMesh) ? "private" : "public";
  } catch {
    return "unresolved";
  }
}

export const classifyCheck = (check: Check, resolve?: Resolver) => classifyHost(checkHost(check), resolve);

const RESOLVE_CONCURRENCY = 10;

/** The monitors whose host is public, as watch entries. A private, loopback, link-local, tunnel or unresolvable host stays out. */
export async function publicEntries(
  monitors: { id: string; check: Check; intervalSec: number }[],
  resolve?: Resolver,
): Promise<WatchEntry[]> {
  const out: (WatchEntry | null)[] = new Array(monitors.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(RESOLVE_CONCURRENCY, monitors.length) }, async () => {
      while (next < monitors.length) {
        const i = next++;
        const m = monitors[i];
        if ((await classifyCheck(m.check, resolve)) === "public") out[i] = { monitorId: m.id, check: m.check, intervalSec: m.intervalSec as IntervalSec };
      }
    }),
  );
  return out.filter((e): e is WatchEntry => e !== null);
}

/** Ports a peer's Traefik answers on at its tunnel address. */
export const MESH_PORTS: readonly number[] = [80, 443];

/** Port an http(s) URL connects to. */
export function urlPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** True for a check the mesh path can carry: a hostname (not an address) on a port the tunnel forwards to Traefik. */
export function meshCarries(check: Check): boolean {
  const host = checkHost(check);
  if (!host || net.isIP(host) !== 0 || host === "localhost" || !host.includes(".")) return false;
  if (check.type !== "http") return MESH_PORTS.includes(check.port);
  try {
    return MESH_PORTS.includes(urlPort(new URL(check.url)));
  } catch {
    return false;
  }
}

/** True when the host is an internal name or every address it resolves to is private. A name that doesn't resolve is false. */
export async function resolvesOnlyPrivate(host: string, resolve: Resolver = resolveAll): Promise<boolean> {
  if (isInternalName(host)) return true;
  try {
    const addresses = await resolve(host);
    return addresses.length > 0 && addresses.every(isPrivateOrMesh);
  } catch {
    return false;
  }
}

/** Mesh-path entries for the monitors whose host resolves only to private addresses. */
export async function privateEntries(
  monitors: { id: string; check: Check; intervalSec: number }[],
  resolve?: Resolver,
): Promise<WatchEntry[]> {
  const out: WatchEntry[] = [];
  for (const m of monitors) {
    if (!meshCarries(m.check)) continue;
    if (await resolvesOnlyPrivate(checkHost(m.check), resolve)) out.push({ monitorId: m.id, check: m.check, intervalSec: m.intervalSec as IntervalSec, path: "mesh" });
  }
  return out;
}

