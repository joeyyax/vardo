// ---------------------------------------------------------------------------
// Routed-service selection — which compose service a domain's Traefik labels
// belong on.
//
// File order alone picks the wrong container in any stack that lists a worker
// or datastore first (authentik lists authentik-worker before authentik-server),
// which puts a non-serving container behind the domain.
// ---------------------------------------------------------------------------

import type { ComposeFile, ComposeService } from "./compose-types";
import { parsePortString } from "./compose-inject";

/** Images that never serve an app's HTTP port. */
const DATASTORE_IMAGE =
  /^(?:.*\/)?(postgres|postgis|mysql|mariadb|percona|mongo|redis|valkey|memcached)\b/i;

/** Service names that name a background role rather than the web tier. */
const BACKGROUND_ROLE =
  /(^|[-_.])(worker|celery|beat|scheduler|cron|queue|consumer|migrate|migrations?|init|backup|sidecar)([-_.]|$)/i;

export type RoutedServiceReason =
  /** `domain.composeService` named it. */
  | "override"
  /** Only one service can be routed at all. */
  | "sole-candidate"
  /** Its `ports`/`expose` declares the app's container port. */
  | "declared-port"
  /** Its image exposes the app's container port. */
  | "image-port"
  /** Every other candidate is a datastore or a background worker. */
  | "role"
  /** Nothing disambiguated — first service in compose order. */
  | "file-order";

export type RoutedServiceSelection = {
  service?: string;
  reason: RoutedServiceReason;
  /** Set when the pick was a guess between these services, in compose order. */
  ambiguous?: string[];
};

/** Container-side ports a service declares via `ports` or `expose`. */
export function declaredContainerPorts(svc: ComposeService): number[] {
  const ports: number[] = [];
  for (const raw of svc.ports ?? []) {
    const parsed = parsePortString(raw);
    if (parsed) ports.push(parsed.internal);
  }
  for (const raw of svc.expose ?? []) {
    const port = parseInt(String(raw).split("/")[0], 10);
    if (!isNaN(port)) ports.push(port);
  }
  return ports;
}

function isServingRole(name: string, svc: ComposeService): boolean {
  if (svc.image && DATASTORE_IMAGE.test(svc.image)) return false;
  return !BACKGROUND_ROLE.test(name);
}

/**
 * Pick the compose service a domain's Traefik labels belong on.
 *
 * Applies each signal in confidence order, keeping a filter only when it
 * narrows the field without emptying it. `reason` names the last signal that
 * narrowed; `ambiguous` is set when the field never got down to one.
 */
export function selectRoutedService(
  compose: ComposeFile,
  opts: {
    /** The app's container port — the port Traefik will send traffic to. */
    containerPort?: number | null;
    /** `domain.composeService`; wins outright when the service exists. */
    override?: string | null;
    /** Ports each service's image exposes, by service name. */
    imagePorts?: Record<string, number[]>;
  } = {},
): RoutedServiceSelection {
  const { containerPort, override, imagePorts } = opts;

  if (override && compose.services[override]) {
    return { service: override, reason: "override" };
  }

  // Services on host/container/none network modes are unreachable from
  // vardo-traefik, so they can never carry the route.
  const candidates = Object.keys(compose.services).filter((name) => {
    const mode = compose.services[name].network_mode;
    return !mode || mode === "bridge";
  });

  if (candidates.length === 0) return { reason: "file-order" };
  if (candidates.length === 1) return { service: candidates[0], reason: "sole-candidate" };

  const port = containerPort ?? 0;
  const filters: { reason: RoutedServiceReason; keep: (name: string) => boolean }[] = [
    {
      reason: "declared-port",
      keep: (n) => port > 0 && declaredContainerPorts(compose.services[n]).includes(port),
    },
    {
      reason: "image-port",
      keep: (n) => port > 0 && (imagePorts?.[n] ?? []).includes(port),
    },
    {
      reason: "role",
      keep: (n) => isServingRole(n, compose.services[n]),
    },
  ];

  let pool = candidates;
  let reason: RoutedServiceReason = "file-order";
  for (const filter of filters) {
    const next = pool.filter(filter.keep);
    if (next.length === 0 || next.length === pool.length) continue;
    pool = next;
    reason = filter.reason;
    if (pool.length === 1) break;
  }

  if (pool.length === 1) return { service: pool[0], reason };
  return { service: pool[0], reason: "file-order", ambiguous: pool };
}
