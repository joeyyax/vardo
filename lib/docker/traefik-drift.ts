// Restarts Traefik when its backends disagree with live container IPs (missed Docker events cause 502s).

import { db } from "@/lib/db";
import { emit } from "@/lib/notifications/dispatch";
import type { BusEvent } from "@/lib/bus";
import { restartContainer } from "./client";
import {
  collectDockerBackends,
  fetchTraefikServices,
  findTraefikContainer,
  ipsOf,
  liveContainers,
  type LiveContainer,
  type TraefikBackend,
} from "./traefik-api";
import { logger } from "@/lib/logger";
import { closeOnShutdown } from "@/lib/shutdown";

const log = logger.child("traefik-drift");

const POLL_INTERVAL_MS = 60_000;
/** Consecutive stale ticks before acting. A deploy swap leaves one legitimately stale tick. */
export const CONFIRM_STREAK = 2;
/** Don't restart Traefik more often than this. */
export const RESTART_BACKOFF_MS = 10 * 60_000;
/** Rolling window for the restart cap. */
export const RESTART_WINDOW_MS = 60 * 60_000;
/** Restarts within RESTART_WINDOW_MS before escalating instead. */
export const MAX_RESTARTS_PER_WINDOW = 3;

/** Alert without restarting when set to "false". */
function autohealEnabled(): boolean {
  return process.env.VARDO_TRAEFIK_DRIFT_AUTOHEAL !== "false";
}

/** Backends whose IP no longer belongs to any running container. */
export function findStaleBackends(
  backends: TraefikBackend[],
  liveIps: Set<string>,
): TraefikBackend[] {
  return backends.filter((b) => !liveIps.has(b.ip));
}

const HTTP_ROUTER_RULE = /^traefik\.http\.routers\.[^.]+\.rule$/;

/** Enabled with its own HTTP router rule; `traefik.enable` alone is never routed. */
export function requestsRouting(labels: Record<string, string>): boolean {
  return (
    labels["traefik.enable"] === "true" && Object.keys(labels).some((k) => HTTP_ROUTER_RULE.test(k))
  );
}

/** Containers that ask to be routed but have no backend in Traefik. */
export function findUnroutedContainers(
  containers: { name: string; labels: Record<string, string>; ips: string[] }[],
  backends: TraefikBackend[],
): string[] {
  const routed = new Set(backends.map((b) => b.ip));
  return containers
    .filter((c) => requestsRouting(c.labels))
    .filter((c) => c.ips.length > 0 && !c.ips.some((ip) => routed.has(ip)))
    .map((c) => c.name);
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

/** Backend URL → consecutive ticks it has read stale. */
let staleStreak = new Map<string, number>();
/** Restart timestamps within RESTART_WINDOW_MS, ascending. */
let restartHistory: number[] = [];
let escalated = false;
let reported = false;
/** Fault keys that were held when Traefik was last restarted. */
let restartedFor = new Set<string>();
/** Fault keys already alerted as surviving a restart. */
let persistentAlerted = new Set<string>();

/** Test seam — reset the accumulated streaks and restart history. */
export function resetDriftState(): void {
  staleStreak = new Map();
  restartHistory = [];
  escalated = false;
  reported = false;
  restartedFor = new Set();
  persistentAlerted = new Set();
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

  let containers: LiveContainer[];
  try {
    containers = await liveContainers();
  } catch (err) {
    log.error("Failed to list containers:", err instanceof Error ? err.message : err);
    return;
  }
  const liveIps = ipsOf(containers);

  // Empty means the Docker read failed, not that every backend is stale.
  if (liveIps.size === 0) return;

  const backends = collectDockerBackends(services);
  // Log once at boot.
  if (!reported) {
    reported = true;
    const wantRouting = containers.filter((c) => requestsRouting(c.labels)).length;
    log.info(
      `Watching ${backends.length} Traefik backend(s) against ${liveIps.size} container IP(s); ${wantRouting} container(s) request routing`,
    );
  }

  // Unrouted containers share the stale-backend streak.
  const unrouted = findUnroutedContainers(containers, backends);

  const stale = findStaleBackends(backends, liveIps);
  if (stale.length === 0 && unrouted.length === 0) {
    staleStreak = new Map();
    escalated = false;
    restartedFor = new Set();
    persistentAlerted = new Set();
    return;
  }

  const faults = [
    ...stale.map((b) => ({ key: b.url, label: `${b.service} → ${b.url}` })),
    ...unrouted.map((name) => ({ key: `unrouted:${name}`, label: `${name} has no Traefik route` })),
  ];

  const next = new Map<string, number>();
  for (const f of faults) next.set(f.key, (staleStreak.get(f.key) ?? 0) + 1);
  staleStreak = next;

  const present = new Set(faults.map((f) => f.key));
  restartedFor = new Set([...restartedFor].filter((k) => present.has(k)));
  persistentAlerted = new Set([...persistentAlerted].filter((k) => present.has(k)));

  const confirmed = faults.filter((f) => (staleStreak.get(f.key) ?? 0) >= CONFIRM_STREAK);

  // A fault that outlived a restart won't clear with another one.
  const survivors = confirmed.filter(
    (f) => restartedFor.has(f.key) && !persistentAlerted.has(f.key),
  );
  if (survivors.length > 0) {
    for (const f of survivors) persistentAlerted.add(f.key);
    const labels = survivors.map((f) => f.label).join(", ");
    log.error(`Survived a Traefik restart, not restarting again: ${labels}`);
    await emitAll({
      type: "system.service-down",
      title: "Traefik routing is stale",
      message: `Traefik routing still disagrees with Docker after a restart: ${labels}. Vardo won't restart Traefik again for this. Manual intervention required.`,
      service: "Traefik",
      description: labels,
    });
  }

  const held = confirmed.filter((f) => !restartedFor.has(f.key));
  if (held.length === 0) return;
  const longest = Math.max(...held.map((f) => staleStreak.get(f.key) ?? 0));

  restartHistory = restartHistory.filter((t) => now - t < RESTART_WINDOW_MS);
  const decision = decideRestart({ streak: longest, recentRestarts: restartHistory, now });

  const summary = held.slice(0, 5).map((f) => f.label).join(", ");
  const detail = `Traefik routing disagrees with Docker in ${held.length} place(s): ${summary}${held.length > 5 ? ", …" : ""}`;

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
  if (ok) for (const f of held) restartedFor.add(f.key);

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

let interval: NodeJS.Timeout | null = null;
let ticking = false;
let unregisterShutdown: (() => void) | null = null;

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

  unregisterShutdown = closeOnShutdown(stopTraefikDriftMonitor);
}

export function stopTraefikDriftMonitor(): void {
  unregisterShutdown?.();
  unregisterShutdown = null;
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info("Monitor stopped");
  }
}
