// ---------------------------------------------------------------------------
// Compose file validation, sanitization, and cycle detection.
// ---------------------------------------------------------------------------

import { resolve } from "path";
import type { ComposeFile, ValidateOptions } from "./compose-types";

// ---------------------------------------------------------------------------
// Constants (exported for use by compose-parse)
// ---------------------------------------------------------------------------

export const ALLOWED_NETWORK_MODES = ["host", "bridge", "none", "service", "container"];
export const ALLOWED_RUNTIMES = ["runc", "nvidia", "sysbox"];

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*$/;
// Port value: literal digits or ${VAR:-default} env interpolation
const PORT_VAL = String.raw`(?:\d+|\$\{[^}]+\})`;
const PORT_RE = new RegExp(
  String.raw`^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:)?` +
  String.raw`(${PORT_VAL}:)?` +
  String.raw`${PORT_VAL}` +
  String.raw`(\/\w+)?$`,
);

const DENIED_MOUNT_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/var/run/docker.sock",
  "/root",
];

/**
 * Returns true if a Docker inspect mount name represents an anonymous volume.
 * Docker assigns a 64-character hex hash as the name for anonymous volumes.
 * An empty name is also treated as anonymous.
 */
export function isAnonymousVolume(name: string): boolean {
  return !name || /^[0-9a-f]{64}$/.test(name);
}

/**
 * Returns true if a compose volume entry is a host bind mount.
 * A bare absolute path like "/data" (no colon) is a Docker anonymous volume —
 * it must not be treated as a bind mount.
 */
function isBindMount(vol: string): boolean {
  return (
    vol.startsWith("./") ||
    vol.startsWith("../") ||
    (vol.startsWith("/") && vol.includes(":"))
  );
}

/**
 * Basic validation of a ComposeFile structure.
 */
export function validateCompose(compose: ComposeFile, opts?: ValidateOptions): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (
    !compose.services ||
    typeof compose.services !== "object" ||
    Object.keys(compose.services).length === 0
  ) {
    errors.push("Compose file must have at least one service");
    return { valid: false, errors };
  }

  for (const [name, svc] of Object.entries(compose.services)) {
    // Validate service name
    if (!SERVICE_NAME_RE.test(name)) {
      errors.push(
        `Service name "${name}" is invalid (must be lowercase alphanumeric with hyphens, starting with a letter)`,
      );
    }

    // Each service must have image or build
    if (!svc.image && !svc.build) {
      errors.push(`Service "${name}" must have either "image" or "build"`);
    }

    // Validate port formats
    if (svc.ports) {
      for (const port of svc.ports) {
        if (!PORT_RE.test(port)) {
          errors.push(
            `Service "${name}" has invalid port format: "${port}"`,
          );
        }
      }
    }

    if (svc.volumes && !opts?.skipMountChecks) {
      for (const vol of svc.volumes) {
        if (isBindMount(vol) && !opts?.allowBindMounts) {
          errors.push(
            `Service "${name}" uses host bind mount "${vol}" — enable the Bind Mounts feature flag to allow this`,
          );
        }
        if (isBindMount(vol) && opts?.allowBindMounts) {
          const rawSource = vol.split(":")[0];
          const mountSource = resolve(rawSource);
          const rootResolved = resolve("/", rawSource);
          if (
            DENIED_MOUNT_PATHS.some((p) => mountSource === p || mountSource.startsWith(p + "/")) ||
            DENIED_MOUNT_PATHS.some((p) => rootResolved === p || rootResolved.startsWith(p + "/"))
          ) {
            const displayPath = mountSource !== rootResolved ? rootResolved : mountSource;
            errors.push(
              `Service "${name}" mounts denied path "${displayPath}" — this path is blocked for security`,
            );
          }
        }
      }
    }

    // Validate network_mode service:X references
    if (svc.network_mode) {
      const nm = svc.network_mode;
      if (nm.startsWith("service:")) {
        const targetService = nm.slice("service:".length);
        if (!targetService) {
          errors.push(`Service "${name}" has invalid network_mode "${nm}" — service name is empty`);
        } else if (!compose.services[targetService]) {
          errors.push(
            `Service "${name}" has network_mode "${nm}" but service "${targetService}" is not defined`,
          );
        } else if (targetService === name) {
          errors.push(`Service "${name}" cannot reference itself in network_mode`);
        }
      }
    }
  }

  // Detect circular chains in service:X network_mode references (A → B → A or longer).
  // Self-references (A → A) are already caught above; this covers multi-hop cycles.
  const cycleMembers = new Set<string>();
  const cycleReported = new Set<string>();
  for (const startName of Object.keys(compose.services)) {
    if (cycleMembers.has(startName)) continue;

    const path: string[] = [];
    const seen = new Set<string>();
    let node = startName;

     
    while (true) {
      const nm = compose.services[node]?.network_mode;
      if (!nm?.startsWith("service:")) break;
      const next = nm.slice("service:".length);
      // Skip invalid/missing/self-ref targets — already reported above
      if (!next || !compose.services[next] || next === node) break;

      if (seen.has(next)) {
        // next appears earlier in the path — cycle detected
        const cycleStart = path.indexOf(next);
        const cycle = [...path.slice(cycleStart), node];
        const cycleKey = [...cycle].sort().join(",");
        if (!cycleReported.has(cycleKey)) {
          cycleReported.add(cycleKey);
          for (const n of cycle) cycleMembers.add(n);
          errors.push(
            `Circular network_mode chain detected: ${[...cycle, next].join(" → ")}`,
          );
        }
        break;
      }

      path.push(node);
      seen.add(node);
      node = next;
    }
  }

  // Detect non-circular chaining: service:B where B itself uses service:X.
  // Docker does not allow network_mode chains — the target must own its network namespace.
  for (const [name, svc] of Object.entries(compose.services)) {
    if (!svc.network_mode?.startsWith("service:")) continue;
    if (cycleMembers.has(name)) continue; // already covered by circular error above

    const targetService = svc.network_mode.slice("service:".length);
    if (!targetService || !compose.services[targetService] || targetService === name) continue;

    if (compose.services[targetService].network_mode?.startsWith("service:")) {
      errors.push(
        `Service "${name}" uses network_mode "service:${targetService}", but "${targetService}" also uses a service: network_mode — Docker does not support chaining`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Strip host bind mounts from compose, keeping only named volumes.
 * When allowBindMounts is true, bind mounts are allowed but paths in
 * DENIED_MOUNT_PATHS are always blocked regardless of the flag.
 * When stripping, returns the list of removed mounts for logging.
 */
export function sanitizeCompose(compose: ComposeFile, opts?: { allowBindMounts?: boolean }): {
  compose: ComposeFile;
  strippedMounts: string[];
} {
  const strippedMounts: string[] = [];
  const sanitized = { ...compose, services: { ...compose.services } };
  for (const [name, svc] of Object.entries(sanitized.services)) {
    if (svc.volumes) {
      const safe: string[] = [];
      for (const v of svc.volumes) {
        if (isBindMount(v)) {
          if (opts?.allowBindMounts) {
            // Bind mounts allowed — still enforce the deny list unconditionally.
            // Throw rather than silently drop: the user explicitly configured this
            // mount, so a silent strip would cause confusing runtime behaviour.
            const rawSource = v.split(":")[0];
            const mountSource = resolve(rawSource);
            // Also resolve from root to catch traversal attacks (e.g. ../../../../../../etc)
            // that would resolve differently depending on CWD depth
            const rootResolved = resolve("/", rawSource);
            if (
              DENIED_MOUNT_PATHS.some((p) => mountSource === p || mountSource.startsWith(p + "/")) ||
              DENIED_MOUNT_PATHS.some((p) => rootResolved === p || rootResolved.startsWith(p + "/"))
            ) {
              const displayPath = mountSource !== rootResolved ? rootResolved : mountSource;
              throw new Error(
                `Service "${name}" mounts blocked host path "${displayPath}" — this path is not allowed even with bind mounts enabled`,
              );
            }
            safe.push(v);
          } else {
            strippedMounts.push(`${name}: ${v}`);
          }
        } else {
          safe.push(v);
        }
      }
      sanitized.services[name] = { ...svc, volumes: safe };
    }
  }
  return { compose: sanitized, strippedMounts };
}
