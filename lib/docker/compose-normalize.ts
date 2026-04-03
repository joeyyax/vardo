// ---------------------------------------------------------------------------
// Compose normalization — transforms user-provided compose into safe runtime
// config. The user's compose is intent; the normalized compose is what runs.
//
// Called early in the deploy pipeline, after stripVardoInjections and before
// Traefik/network injection.
// ---------------------------------------------------------------------------

import type { ComposeFile } from "./compose";
import { parsePortString, stripHostPorts } from "./compose";

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
  routedServices: Set<string>;
  /** The app's desired restart policy (default: "unless-stopped"). */
  restartPolicy?: string;
  /** Skip host port stripping (e.g., user explicitly opted out). */
  keepHostPorts?: boolean;
};

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
    result = normalizeHostPorts(result, opts.routedServices, changes);
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
 * - "always" → left as-is (valid choice, just aggressive)
 * - "unless-stopped" / "on-failure" → left as-is
 */
function normalizeRestart(
  compose: ComposeFile,
  targetPolicy: string,
  changes: NormalizeChange[],
): ComposeFile {
  const services = { ...compose.services };

  for (const [name, svc] of Object.entries(services)) {
    if (!svc.restart) {
      services[name] = { ...svc, restart: targetPolicy };
      changes.push({
        service: name,
        field: "restart",
        action: "added",
        after: targetPolicy,
        reason: "Restart policy set — services should restart on failure in production",
      });
    } else if (svc.restart === "no") {
      services[name] = { ...svc, restart: targetPolicy };
      changes.push({
        service: name,
        field: "restart",
        action: "changed",
        before: "no",
        after: targetPolicy,
        reason: 'restart: "no" changed — services should restart on failure in production',
      });
    }
  }

  return { ...compose, services };
}
