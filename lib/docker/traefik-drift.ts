// ---------------------------------------------------------------------------
// Traefik routing drift
//
// Traefik's Docker provider learns container IPs from the event stream. A daemon
// restart drops that stream, and a reconnect that misses the intervening events
// leaves Traefik routing to addresses no container holds — every affected domain
// 502s until someone restarts it by hand. This polls Traefik's own view of its
// backends against the live container IPs and restarts it when they disagree.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { emit } from "@/lib/notifications/dispatch";
import type { BusEvent } from "@/lib/bus";
import { dockerRequest, listAllContainers, restartContainer } from "./client";
import { logger } from "@/lib/logger";

const log = logger.child("traefik-drift");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 60_000;
/** Consecutive ticks the same backend must read stale before we act. A deploy
 *  swap leaves one tick of legitimate staleness while Traefik catches up. */
export const CONFIRM_STREAK = 2;
/** Don't restart Traefik more often than this. */
export const RESTART_BACKOFF_MS = 10 * 60_000;
/** Rolling window for the restart cap. */
export const RESTART_WINDOW_MS = 60 * 60_000;
/** Restarts within RESTART_WINDOW_MS before we stop trying and escalate. */
export const MAX_RESTARTS_PER_WINDOW = 3;

function apiUrl(): string {
  return process.env.TRAEFIK_API_URL ?? "http://vardo-traefik:8080";
}

/** Alert without restarting when set to "false". */
function autohealEnabled(): boolean {
  return process.env.VARDO_TRAEFIK_DRIFT_AUTOHEAL !== "false";
}

// ---------------------------------------------------------------------------
// Pure decision logic (unit tested)
// ---------------------------------------------------------------------------

export type TraefikBackend = { service: string; url: string; ip: string };

type TraefikService = {
  name?: string;
  provider?: string;
  status?: string;
  loadBalancer?: { servers?: { url?: string }[] };
};

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

/** Backends whose IP no longer belongs to any running container. */
export function findStaleBackends(
  backends: TraefikBackend[],
  liveIps: Set<string>,
): TraefikBackend[] {
  return backends.filter((b) => !liveIps.has(b.ip));
}

export type DriftDecision = "wait" | "restart" | "backoff" | "giveup";

/** What to do about a drift that has held for `streak` ticks. */
export function decideRestart(opts: {
  streak: number;
  recentRestarts: number[];
  now: number;
}): DriftDecision {
  if (opts.streak < CONFIRM_STREAK) return "wait";
  if (opts.recentRestarts.length >= MAX_RESTARTS_PER_WINDOW) return "giveup";
  const last = opts.recentRestarts[opts.recentRestarts.length - 1];
  if (last !== undefined && opts.now - last < RESTART_BACKOFF_MS) return "backoff";
  return "restart";
}

// ---------------------------------------------------------------------------
// Docker + Traefik reads
// ---------------------------------------------------------------------------

type ContainerListEntry = {
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }> };
};

/** Every IP held by a running container, across all networks. */
export async function liveContainerIps(): Promise<Set<string>> {
  const filters = encodeURIComponent(JSON.stringify({ status: ["running"] }));
  const containers = await dockerRequest<ContainerListEntry[]>(
    "GET",
    `/containers/json?filters=${filters}`,
  );

  const ips = new Set<string>();
  for (const c of containers) {
    for (const net of Object.values(c.NetworkSettings?.Networks ?? {})) {
      if (net.IPAddress) ips.add(net.IPAddress);
      if (net.GlobalIPv6Address) ips.add(net.GlobalIPv6Address);
    }
  }
  return ips;
}

async function fetchTraefikServices(): Promise<TraefikService[] | null> {
  try {
    const res = await fetch(`${apiUrl()}/api/http/services`, {
      // Next patches global fetch; a cached routing table would defeat the check.
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      log.warn(`Traefik API returned ${res.status}`);
      return null;
    }
    return (await res.json()) as TraefikService[];
  } catch (err) {
    log.warn("Traefik API unreachable:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The running Traefik container. Override the name with VARDO_TRAEFIK_CONTAINER. */
async function findTraefikContainer(): Promise<{ id: string; name: string } | null> {
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

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/** Backend URL → consecutive ticks it has read stale. */
let staleStreak = new Map<string, number>();
/** Restart timestamps within RESTART_WINDOW_MS, ascending. */
let restartHistory: number[] = [];
let escalated = false;
let reported = false;

/** Test seam — reset the accumulated streaks and restart history. */
export function resetDriftState(): void {
  staleStreak = new Map();
  restartHistory = [];
  escalated = false;
  reported = false;
}

async function emitAll(event: BusEvent): Promise<void> {
  try {
    const orgs = await db.query.organizations.findMany({ columns: { id: true } });
    for (const org of orgs) emit(org.id, event);
  } catch (err) {
    log.error("Failed to emit drift alert:", err);
  }
}

export async function tickTraefikDrift(): Promise<void> {
  const now = Date.now();

  const services = await fetchTraefikServices();
  if (!services) return;

  let liveIps: Set<string>;
  try {
    liveIps = await liveContainerIps();
  } catch (err) {
    log.error("Failed to list containers:", err instanceof Error ? err.message : err);
    return;
  }

  // An empty container list means the Docker read failed open, not that every
  // backend is stale — restarting Traefik on that would be self-inflicted.
  if (liveIps.size === 0) return;

  const backends = collectDockerBackends(services);
  // One line at boot, so a monitor that reads nothing is visible rather than
  // indistinguishable from a monitor that found no drift.
  if (!reported) {
    reported = true;
    log.info(`Watching ${backends.length} Traefik backend(s) against ${liveIps.size} container IP(s)`);
  }

  const stale = findStaleBackends(backends, liveIps);
  if (stale.length === 0) {
    staleStreak = new Map();
    escalated = false;
    return;
  }

  const next = new Map<string, number>();
  for (const b of stale) next.set(b.url, (staleStreak.get(b.url) ?? 0) + 1);
  staleStreak = next;

  // A backend stale on one tick is a deploy in flight, not drift.
  const longest = Math.max(...stale.map((b) => staleStreak.get(b.url) ?? 0));
  const held = stale.filter((b) => (staleStreak.get(b.url) ?? 0) >= CONFIRM_STREAK);
  if (held.length === 0) return;

  restartHistory = restartHistory.filter((t) => now - t < RESTART_WINDOW_MS);
  const decision = decideRestart({ streak: longest, recentRestarts: restartHistory, now });

  const summary = held
    .slice(0, 5)
    .map((b) => `${b.service} → ${b.url}`)
    .join(", ");
  const detail = `${held.length} Traefik backend(s) point at addresses no container holds: ${summary}${held.length > 5 ? ", …" : ""}`;

  if (decision === "backoff") return;

  if (decision === "giveup") {
    if (escalated) return;
    escalated = true;
    log.error(`${detail} — restarted ${MAX_RESTARTS_PER_WINDOW}x this hour without clearing`);
    await emitAll({
      type: "system.service-down",
      title: "Traefik routing is stale",
      message: `${detail}. Traefik has been restarted ${MAX_RESTARTS_PER_WINDOW} times in the last hour and the routing table still disagrees with Docker. Manual intervention required — affected domains are returning 502.`,
      service: "Traefik",
      description: detail,
    });
    return;
  }

  if (!autohealEnabled()) {
    if (escalated) return;
    escalated = true;
    log.error(`${detail} — autoheal disabled, not restarting`);
    await emitAll({
      type: "system.service-down",
      title: "Traefik routing is stale",
      message: `${detail}. Restart Traefik to reload its routing table — affected domains are returning 502.`,
      service: "Traefik",
      description: detail,
    });
    return;
  }

  const traefik = await findTraefikContainer();
  if (!traefik) {
    log.error(`${detail} — no running Traefik container found to restart`);
    return;
  }

  let ok = true;
  try {
    await restartContainer(traefik.id);
    log.info(`Restarted ${traefik.name} — ${detail}`);
  } catch (err) {
    ok = false;
    log.error(`Failed to restart ${traefik.name}:`, err instanceof Error ? err.message : err);
  }

  restartHistory.push(now);
  staleStreak = new Map();

  await emitAll({
    type: "system.service-down",
    title: ok ? "Traefik restarted to clear stale routes" : "Traefik restart failed",
    message: ok
      ? `${detail}. Traefik was restarted to reload its routing table (${restartHistory.length}/${MAX_RESTARTS_PER_WINDOW} restarts this hour).`
      : `${detail}. The automatic restart failed — affected domains will keep returning 502 until Traefik is restarted manually.`,
    service: "Traefik",
    description: detail,
  });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let interval: NodeJS.Timeout | null = null;
let ticking = false;

export function startTraefikDriftMonitor(): void {
  if (interval) return;

  log.info(`Monitor started (${POLL_INTERVAL_MS / 1000}s interval)`);
  interval = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tickTraefikDrift();
    } catch (err) {
      log.error("Tick error:", err);
    } finally {
      ticking = false;
    }
  }, POLL_INTERVAL_MS);
}

export function stopTraefikDriftMonitor(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Monitor stopped");
  }
}

function onShutdown(signal: string) {
  log.info(`Received ${signal} — stopping monitor`);
  stopTraefikDriftMonitor();
}

process.once("SIGTERM", () => onShutdown("SIGTERM"));
process.once("SIGINT", () => onShutdown("SIGINT"));
process.once("exit", () => stopTraefikDriftMonitor());
