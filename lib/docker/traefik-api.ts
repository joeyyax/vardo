// ---------------------------------------------------------------------------
// Traefik admin API reads
//
// Traefik's own view of its routers and services, the live container addresses
// it is meant to match, and the parsing that turns both into comparable shapes.
// ---------------------------------------------------------------------------

import { dockerRequest, listAllContainers } from "./client";
import { logger } from "@/lib/logger";

const log = logger.child("traefik-api");

function apiUrl(): string {
  return process.env.TRAEFIK_API_URL ?? "http://vardo-traefik:8080";
}

// ---------------------------------------------------------------------------
// Traefik reads
// ---------------------------------------------------------------------------

export type TraefikBackend = { service: string; url: string; ip: string };

type TraefikService = {
  name?: string;
  provider?: string;
  status?: string;
  loadBalancer?: { servers?: { url?: string }[] };
};

export type TraefikRouter = { name?: string; status?: string; provider?: string };

/** Read a Traefik API collection, or null when Traefik can't be reached. */
async function fetchTraefik<T>(path: string): Promise<T[] | null> {
  try {
    const res = await fetch(`${apiUrl()}${path}`, {
      // Next patches global fetch; a cached routing table would defeat the check.
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      log.warn(`Traefik API returned ${res.status} for ${path}`);
      return null;
    }
    return (await res.json()) as T[];
  } catch (err) {
    log.warn("Traefik API unreachable:", err instanceof Error ? err.message : err);
    return null;
  }
}

export function fetchTraefikServices(): Promise<TraefikService[] | null> {
  return fetchTraefik<TraefikService>("/api/http/services");
}

export function fetchTraefikRouters(): Promise<TraefikRouter[] | null> {
  return fetchTraefik<TraefikRouter>("/api/http/routers");
}

/** IPv4 or bracketed IPv6 host of a backend URL, or null for a hostname. */
export function backendIp(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
  const isV6 = bare.includes(":");
  return isV4 || isV6 ? bare : null;
}

/**
 * Docker-provider backends pointing at an IP address. Hostname backends resolve
 * through Docker's DNS at request time, so they can't drift the same way and are
 * left out of the comparison.
 */
export function collectDockerBackends(services: TraefikService[]): TraefikBackend[] {
  const out: TraefikBackend[] = [];
  for (const svc of services) {
    if (svc.provider !== "docker" || svc.status !== "enabled") continue;
    for (const server of svc.loadBalancer?.servers ?? []) {
      if (!server.url) continue;
      const ip = backendIp(server.url);
      if (ip) out.push({ service: svc.name ?? "?", url: server.url, ip });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Docker reads
// ---------------------------------------------------------------------------

type ContainerListEntry = {
  Names?: string[];
  Labels?: Record<string, string>;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }> };
};

export type LiveContainer = { name: string; labels: Record<string, string>; ips: string[] };

/** Running containers with their addresses and labels. */
export async function liveContainers(): Promise<LiveContainer[]> {
  const filters = encodeURIComponent(JSON.stringify({ status: ["running"] }));
  const containers = await dockerRequest<ContainerListEntry[]>(
    "GET",
    `/containers/json?filters=${filters}`,
  );

  return containers.map((c) => {
    const ips: string[] = [];
    for (const net of Object.values(c.NetworkSettings?.Networks ?? {})) {
      if (net.IPAddress) ips.push(net.IPAddress);
      if (net.GlobalIPv6Address) ips.push(net.GlobalIPv6Address);
    }
    return {
      name: c.Names?.[0]?.replace(/^\//, "") ?? "?",
      labels: c.Labels ?? {},
      ips,
    };
  });
}

/** Every IP held by a running container, across all networks. */
export function ipsOf(containers: LiveContainer[]): Set<string> {
  return new Set(containers.flatMap((c) => c.ips));
}

/** The running Traefik container. Override the name with VARDO_TRAEFIK_CONTAINER. */
export async function findTraefikContainer(): Promise<{ id: string; name: string } | null> {
  const configured = process.env.VARDO_TRAEFIK_CONTAINER;
  const containers = await listAllContainers();
  const running = containers.filter((c) => c.state === "running");

  if (configured) {
    const byName = running.find((c) => c.name === configured);
    return byName ? { id: byName.id, name: byName.name } : null;
  }

  const byImage = running.find((c) => /^(docker\.io\/)?(library\/)?traefik(:|$)/.test(c.image));
  return byImage ? { id: byImage.id, name: byImage.name } : null;
}
