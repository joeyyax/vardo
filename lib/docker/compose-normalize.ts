// ---------------------------------------------------------------------------
// Compose normalization — transforms user-provided compose into safe runtime
// config. The user's compose is intent; the normalized compose is what runs.
//
// Called early in the deploy pipeline, after stripVardoInjections and before
// Traefik/network injection.
// ---------------------------------------------------------------------------

import type { ComposeFile } from "./compose";
import { parsePortString, stripHostPorts } from "./compose";
import { selectRoutedService } from "./routed-service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** The app's desired restart policy (default: "unless-stopped"). */
  restartPolicy?: string;
  /** Skip host port stripping (e.g., user explicitly opted out). */
  keepHostPorts?: boolean;
};

// ---------------------------------------------------------------------------
// Routed service detection
// ---------------------------------------------------------------------------

/**
 * Determine which services are routed via Traefik (have domains).
 *
 * When the app has at least one domain, the service that serves its port is
 * Traefik-routed. Pass `containerPort` so the selection can use it.
 */
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

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

export function normalizeCompose(
  compose: ComposeFile,
  opts: NormalizeOptions,
): NormalizeResult {
  const changes: NormalizeChange[] = [];
  let result = structuredClone(compose);

  // 1. Strip host ports from Traefik-routed services
  if (!opts.keepHostPorts) {
    result = normalizeHostPorts(result, opts.routedServices ?? new Set(), changes);
  }

  // 2. Normalize restart policies
  result = normalizeRestart(result, opts.restartPolicy ?? "unless-stopped", changes);

  return { compose: result, changes };
}

// ---------------------------------------------------------------------------
// Individual normalizers
// ---------------------------------------------------------------------------

/**
 * Strip host port bindings from all Traefik-routed services.
 * Non-routed services keep their ports (databases, MQTT, etc.).
 */
function normalizeHostPorts(
  compose: ComposeFile,
  routedServices: Set<string>,
  changes: NormalizeChange[],
): ComposeFile {
  let result = compose;

  for (const [name, svc] of Object.entries(compose.services)) {
    if (!routedServices.has(name) || !svc.ports) continue;

    // Check what ports will be stripped
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
 * Normalize restart policies across all services.
 * - Missing → set to target policy
 * - "no" → set to target policy (services should restart in production)
 * - "always" → downgraded to "unless-stopped"
 * - "unless-stopped" / "on-failure" → left as-is
 */
function normalizeRestart(
  compose: ComposeFile,
  targetPolicy: string,
  changes: NormalizeChange[],
): ComposeFile {
  const services = { ...compose.services };
  const safePolicy = targetPolicy === "always" ? "unless-stopped" : targetPolicy;

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
    } else if (svc.restart === "no") {
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
      // Docker restarts an "always" container when the daemon restarts even if it
      // was explicitly stopped, which would bring a standby slot back up alongside
      // the active one. "unless-stopped" is identical except for that case.
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
