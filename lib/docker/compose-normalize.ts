// Turns user compose into safe runtime config. Runs after stripVardoInjections, before Traefik/network injection.

import type { ComposeFile } from "./compose";
import { parsePortString, stripHostPorts } from "./compose";
import { selectRoutedService } from "./routed-service";

export type NormalizeChange = {
  service: string;
  field: string;
  action: "removed" | "changed" | "added";
  before?: unknown;
  after?: unknown;
  reason: string;
};

export type NormalizeResult = {
  compose: ComposeFile;
  changes: NormalizeChange[];
};

export type NormalizeOptions = {
  /** Service names that have domains configured (routed via Traefik). */
  routedServices?: Set<string>;
  /** The app's restart policy column (default: "unless-stopped"). */
  restartPolicy?: string | null;
  /** Skip host port stripping (e.g., user explicitly opted out). */
  keepHostPorts?: boolean;
};

/** Restart policies Docker accepts. */
const VALID_RESTART = /^(no|always|unless-stopped|on-failure(:\d+)?)$/;
const DEFAULT_RESTART = "unless-stopped";

/** Services routed via Traefik: the one serving the app's port, when the app has a domain. */
export function getRoutedServices(
  compose: ComposeFile,
  domainCount: number,
  containerPort?: number | null,
): Set<string> {
  const routed = new Set<string>();
  if (domainCount > 0) {
    const { service } = selectRoutedService(compose, { containerPort });
    if (service) routed.add(service);
  }
  return routed;
}

export function normalizeCompose(
  compose: ComposeFile,
  opts: NormalizeOptions,
): NormalizeResult {
  const changes: NormalizeChange[] = [];
  let result = structuredClone(compose);

  if (!opts.keepHostPorts) {
    result = normalizeHostPorts(result, opts.routedServices ?? new Set(), changes);
  }

  result = normalizeRestart(result, opts.restartPolicy ?? DEFAULT_RESTART, changes);

  return { compose: result, changes };
}

/** Strip host port bindings from Traefik-routed services. Non-routed services keep theirs. */
function normalizeHostPorts(
  compose: ComposeFile,
  routedServices: Set<string>,
  changes: NormalizeChange[],
): ComposeFile {
  let result = compose;

  for (const [name, svc] of Object.entries(compose.services)) {
    if (!routedServices.has(name) || !svc.ports) continue;

    for (const raw of svc.ports) {
      const parsed = parsePortString(raw);
      if (parsed && parsed.external !== undefined) {
        changes.push({
          service: name,
          field: "ports",
          action: "removed",
          before: raw,
          reason: "Host port binding removed — Traefik handles routing for this service",
        });
      }
    }

    result = stripHostPorts(result, name);
  }

  return result;
}

/**
 * Normalize restart policies. A service's own `restart:` wins, except "always" and "no"
 * (unless the app column also says "no"); otherwise the app column, then the default.
 */
function normalizeRestart(
  compose: ComposeFile,
  targetPolicy: string,
  changes: NormalizeChange[],
): ComposeFile {
  const services = { ...compose.services };
  // Free-text column; an invalid value would fail every `docker compose up`.
  const requested = VALID_RESTART.test(targetPolicy) ? targetPolicy : DEFAULT_RESTART;
  const safePolicy = requested === "always" ? "unless-stopped" : requested;

  for (const [name, svc] of Object.entries(services)) {
    if (!svc.restart) {
      services[name] = { ...svc, restart: safePolicy };
      changes.push({
        service: name,
        field: "restart",
        action: "added",
        after: safePolicy,
        reason: "Restart policy set — services should restart on failure in production",
      });
    } else if (svc.restart === "no" && safePolicy !== "no") {
      services[name] = { ...svc, restart: safePolicy };
      changes.push({
        service: name,
        field: "restart",
        action: "changed",
        before: "no",
        after: safePolicy,
        reason: 'restart: "no" changed — services should restart on failure in production',
      });
    } else if (svc.restart === "always") {
      // "always" resurrects the stopped standby slot on daemon restart.
      services[name] = { ...svc, restart: "unless-stopped" };
      changes.push({
        service: name,
        field: "restart",
        action: "changed",
        before: "always",
        after: "unless-stopped",
        reason:
          'restart: "always" downgraded — it would resurrect the stopped standby slot on daemon restart',
      });
    }
  }

  return { ...compose, services };
}
