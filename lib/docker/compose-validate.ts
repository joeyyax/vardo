// ---------------------------------------------------------------------------
// Compose file validation, sanitization, and cycle detection.
// ---------------------------------------------------------------------------

import { resolve } from "path";
import YAML from "yaml";
import type { ComposeFile, ComposeService, ValidateOptions } from "./compose-types";
import { dependsOnKeys } from "./compose-types";
import { SHARED_MARKER, isSharedService } from "./slot-partition";
import { getTraefikRoutedServices } from "./compose-inject";
import { selectRoutedService } from "./routed-service";

// ---------------------------------------------------------------------------
// Constants (exported for use by compose-parse)
// ---------------------------------------------------------------------------

export const ALLOWED_NETWORK_MODES = ["host", "bridge", "none", "service", "container"];
export const ALLOWED_RUNTIMES = ["runc", "nvidia", "sysbox"];

/**
 * Parse compose YAML with merge keys resolved, the way Docker Compose reads it.
 *
 * Under YAML 1.2 `<<` is an ordinary key, so `<<: *anchor` leaves the anchor's
 * keys nested under `"<<"` where nothing downstream looks. Docker's Go parser
 * merges them, so an unresolved `<<` hides settings Docker is applying — a
 * service reading as shared to Docker and rotating to Vardo.
 *
 * Throws on unresolvable merge sources, which Docker rejects too.
 */
export function parseComposeYaml(yamlText: string): unknown {
  // Merge resolution skips the alias-expansion guard, so a few hundred bytes of
  // nested `<<` can pin the event loop. The merge-free parse still counts the
  // aliases and throws first.
  YAML.parse(yamlText);
  return YAML.parse(yamlText, { merge: true });
}

/**
 * Whether network_mode names a namespace Docker understands.
 *
 * Anything else is a network *name*. Docker accepts it without complaint and
 * then ignores it — the service lands on its compose project's default network
 * instead. `network_mode: vardo-network` took request.yax.me down this way.
 */
export function isSpecialNetworkMode(nm: string): boolean {
  return ALLOWED_NETWORK_MODES.some((p) => nm === p || nm.startsWith(p + ":"));
}

/**
 * Services whose network_mode names a network rather than a namespace.
 * Takes raw compose YAML so it can audit stored config that was never parsed.
 */
export function findNamedNetworkModes(
  yamlText: string,
): { service: string; networkMode: string }[] {
  let root: unknown;
  try {
    root = parseComposeYaml(yamlText);
  } catch {
    return [];
  }
  if (!root || typeof root !== "object") return [];

  const services = (root as { services?: unknown }).services;
  if (!services || typeof services !== "object") return [];

  const found: { service: string; networkMode: string }[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const nm = (raw as { network_mode?: unknown }).network_mode;
    if (typeof nm !== "string" || !nm) continue;
    if (isSpecialNetworkMode(nm)) continue;
    found.push({ service: name, networkMode: nm });
  }
  return found;
}

/**
 * Rewrite `network_mode: <network name>` as membership of that network, and
 * declare the network external so Compose attaches to the existing one rather
 * than creating a project-prefixed copy.
 *
 * Special modes (host, none, bridge, container:, service:) are namespaces and
 * are left alone. Returns the input unchanged when there is nothing to move.
 */
export function normalizeNamedNetworkModes(compose: ComposeFile): ComposeFile {
  const services: Record<string, ComposeService> = {};
  const moved = new Set<string>();

  for (const [name, svc] of Object.entries(compose.services)) {
    const nm = svc.network_mode;
    if (!nm || isSpecialNetworkMode(nm)) {
      services[name] = svc;
      continue;
    }
    const { network_mode: _mode, ...rest } = svc;
    services[name] = { ...rest, networks: [...new Set([...(svc.networks ?? []), nm])] };
    moved.add(nm);
  }

  if (moved.size === 0) return compose;

  const networks = { ...(compose.networks ?? {}) } as Record<string, unknown>;
  for (const net of moved) {
    if (!(net in networks)) networks[net] = { external: true };
  }

  return { ...compose, services, networks };
}

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

// /var/run is conventionally a symlink to /run, so a compose file may reference
// the Docker socket via either path.
const DOCKER_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock"];

/**
 * Returns true if a resolved bind-mount source is the host Docker socket.
 * Checked against both the cwd-resolved and root-resolved forms so a traversal
 * (e.g. ../../../var/run/docker.sock) can't slip past the gate. (#744)
 */
function isDockerSocketMount(mountSource: string, rootResolved: string): boolean {
  return (
    DOCKER_SOCKET_PATHS.includes(mountSource) ||
    DOCKER_SOCKET_PATHS.includes(rootResolved)
  );
}

// ---------------------------------------------------------------------------
// x-vardo-shared
// ---------------------------------------------------------------------------

/**
 * Services a deploy will put behind Traefik, resolved the way swap.ts does it:
 * the labeled ones, or the one Vardo would pick. A pick that was a guess is
 * dropped — swap.ts settles it with a container port validation doesn't have.
 */
function routedServiceNames(compose: ComposeFile): string[] {
  const labeled = getTraefikRoutedServices(compose);
  if (labeled.size > 0) return [...labeled];
  const selection = selectRoutedService(compose);
  return selection.service && !selection.ambiguous ? [selection.service] : [];
}

/**
 * Misuses of x-vardo-shared, caught before a deploy runs. The last two reach
 * Docker as an unresolvable reference, or don't fail at all.
 */
function sharedServiceErrors(compose: ComposeFile): string[] {
  const errors: string[] = [];
  const names = Object.keys(compose.services);
  const shared = new Set(names.filter((n) => isSharedService(compose.services[n])));
  if (shared.size === 0) return errors;

  if (shared.size === names.length) {
    errors.push(
      `Every service is marked ${SHARED_MARKER}, so a deploy would have nothing to replace — leave at least one service out of it`,
    );
    return errors;
  }

  for (const name of shared) {
    const svc = compose.services[name];

    const rotating = dependsOnKeys(svc.depends_on ?? []).filter(
      (dep) => dep in compose.services && !shared.has(dep),
    );
    if (rotating.length > 0) {
      errors.push(
        `Service "${name}" is marked ${SHARED_MARKER} but depends on ${rotating.join(", ")}, which ${rotating.length === 1 ? "is" : "are"} replaced on every deploy — a shared service can only depend on other shared services`,
      );
    }

    if (svc.build) {
      errors.push(
        `Service "${name}" is marked ${SHARED_MARKER} but has "build" — shared services are brought up with --no-recreate, so the image rebuilt on each deploy would never run; drop the marker or use "image"`,
      );
    }
  }

  for (const name of names) {
    if (shared.has(name)) continue;
    const nm = compose.services[name].network_mode;
    if (!nm?.startsWith("service:")) continue;
    const target = nm.slice("service:".length);
    if (shared.has(target)) {
      errors.push(
        `Service "${name}" has network_mode "${nm}", but "${target}" is marked ${SHARED_MARKER} — the two deploy as separate compose projects, where that reference cannot resolve`,
      );
    }
  }

  for (const name of routedServiceNames(compose)) {
    if (shared.has(name)) {
      errors.push(
        `Service "${name}" is marked ${SHARED_MARKER} but it is the service Vardo routes traffic to — a deploy would replace every service except the one users reach, so it would appear to succeed while shipping nothing`,
      );
    }
  }

  return errors;
}

/**
 * Services marked x-vardo-shared.
 * Takes raw compose YAML so the UI can read stored config directly.
 */
export function sharedServiceNames(yamlText: string): string[] {
  let root: unknown;
  try {
    root = parseComposeYaml(yamlText);
  } catch {
    return [];
  }
  if (!root || typeof root !== "object") return [];

  const services = (root as { services?: unknown }).services;
  if (!services || typeof services !== "object") return [];

  const marked: string[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    if ((raw as Record<string, unknown>)[SHARED_MARKER] === true) marked.push(name);
  }
  return marked;
}

export type MistypedSharedMarker = { service: string; value: unknown };

/** YAML 1.1 falsy spellings the 1.2 core schema resolves as plain strings. */
const FALSY_SPELLINGS = new Set(["false", "no", "off", "n", "f"]);

/**
 * Whether a dropped marker could have been meant as "shared".
 *
 * A value meaning "not shared" produces the same outcome dropped as honored, so
 * blocking it would refuse a deploy that was never at risk. Anything else could
 * have meant true, and a dropped true puts two databases on one volume.
 */
export function sharedMarkerIsHazardous(value: unknown): boolean {
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !FALSY_SPELLINGS.has(value.trim().toLowerCase());
  return true;
}

/**
 * Services setting x-vardo-shared to anything other than a boolean.
 *
 * parseCompose only carries the marker through when it is a boolean, so
 * `x-vardo-shared: "true"` is dropped and the service is blue/green'd — two
 * database containers onto one data directory. Takes raw YAML because after
 * parsing, a quoted marker and an absent one are the same thing.
 */
export function findMistypedSharedMarkers(yamlText: string): MistypedSharedMarker[] {
  let root: unknown;
  try {
    root = parseComposeYaml(yamlText);
  } catch {
    return [];
  }
  if (!root || typeof root !== "object") return [];

  const services = (root as { services?: unknown }).services;
  if (!services || typeof services !== "object") return [];

  const found: MistypedSharedMarker[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    if (!(SHARED_MARKER in (raw as Record<string, unknown>))) continue;
    const value = (raw as Record<string, unknown>)[SHARED_MARKER];
    if (typeof value === "boolean") continue;
    found.push({ service: name, value });
  }
  return found;
}

/** How a rejected marker value reads back to the operator. */
function describeMarkerValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (typeof value === "number") return `the number ${value}`;
  if (typeof value === "object") return "a mapping";
  return String(value);
}

/**
 * Blocking errors for markers that could have meant "shared".
 * Every caller holding raw compose text should run this before storing it.
 */
export function sharedMarkerTypeErrors(yamlText: string): string[] {
  return findMistypedSharedMarkers(yamlText)
    .filter(({ value }) => sharedMarkerIsHazardous(value))
    .map(
      ({ service, value }) =>
        `Service "${service}" sets ${SHARED_MARKER} to ${describeMarkerValue(value)}, not a boolean — ` +
        `the marker is ignored, so the service would be replaced on every deploy. ` +
        `Write it unquoted: ${SHARED_MARKER}: true`,
    );
}

/** Non-blocking notes for markers that already behave as written. */
export function sharedMarkerWarnings(yamlText: string): string[] {
  return findMistypedSharedMarkers(yamlText)
    .filter(({ value }) => !sharedMarkerIsHazardous(value))
    .map(
      ({ service, value }) =>
        `Service "${service}" sets ${SHARED_MARKER} to ${describeMarkerValue(value)}, not a boolean. ` +
        `It reads as not-shared, which is what an ignored marker already does, so nothing changes. ` +
        `Write it unquoted: ${SHARED_MARKER}: false`,
    );
}

/**
 * Service keys parseCompose carries through. Anything outside this set is
 * dropped on the way to the generated compose file.
 */
const PARSED_SERVICE_KEYS = new Set([
  "image", "build", "restart", "ports", "expose", "environment", "env_file",
  "volumes", "labels", "networks", "depends_on", "network_mode", "runtime",
  "deploy", "oom_score_adj", "mem_reservation", "cpu_shares", "cap_add",
  "cap_drop", "devices", "privileged", "security_opt", "shm_size", "init",
  "extra_hosts", "healthcheck", "ulimits", "hostname", "user", "stop_signal",
  "entrypoint", "command", "tmpfs", "group_add", "container_name", "configs",
  "secrets", SHARED_MARKER,
]);

/**
 * Valid Compose service keys Vardo drops. Docker would honor every one of
 * these, so a silent drop changes behavior with nothing in the log to say so.
 */
const DROPPED_SERVICE_KEYS = new Set([
  "mem_limit", "cpus", "cpu_count", "cpu_percent", "cpuset", "memswap_limit",
  "mem_swappiness", "pids_limit", "blkio_config", "device_cgroup_rules",
  "logging", "profiles", "pull_policy", "platform", "working_dir", "domainname",
  "stdin_open", "tty", "stop_grace_period", "dns", "dns_search", "dns_opt",
  "sysctls", "userns_mode", "ipc", "pid", "uts", "cgroup", "cgroup_parent",
  "isolation", "read_only", "storage_opt", "annotations", "attach", "links",
  "external_links", "volumes_from", "label_file", "post_start", "pre_stop",
  "credential_spec", "scale", "develop", "provider", "extends",
]);

/**
 * Report Compose keys that Docker honors and Vardo drops.
 *
 * WARNING: adding a key to the parser without removing it here leaves a
 * warning that contradicts the behavior.
 */
export function droppedKeyWarnings(compose: unknown): string[] {
  if (typeof compose !== "object" || compose === null || Array.isArray(compose)) return [];
  const root = compose as Record<string, unknown>;
  const services = root.services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return [];

  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const dropped = Object.keys(raw as Record<string, unknown>).filter(
      (key) => !PARSED_SERVICE_KEYS.has(key) && DROPPED_SERVICE_KEYS.has(key),
    );
    if (dropped.length > 0) {
      warnings.push(
        `Service "${name}" sets ${dropped.map((k) => `"${k}"`).join(", ")}, which Vardo does not apply. ` +
          `Docker would honor ${dropped.length === 1 ? "it" : "them"} — the deployed container will not.`,
      );
    }
  }
  return warnings;
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
        if (!isBindMount(vol)) continue;
        const rawSource = vol.split(":")[0];
        const mountSource = resolve(rawSource);
        const rootResolved = resolve("/", rawSource);

        // Docker socket is gated by its own flag, independent of bind mounts.
        if (isDockerSocketMount(mountSource, rootResolved)) {
          if (!opts?.allowDockerSocket) {
            errors.push(
              `Service "${name}" mounts the Docker socket "${vol}" — enable the Docker Socket feature flag to allow this`,
            );
          }
          continue;
        }

        if (!opts?.allowBindMounts) {
          errors.push(
            `Service "${name}" uses host bind mount "${vol}" — enable the Bind Mounts feature flag to allow this`,
          );
          continue;
        }

        // Bind mounts allowed — the rest of the deny-list stays enforced.
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

  errors.push(...sharedServiceErrors(compose));

  return { valid: errors.length === 0, errors };
}

/**
 * Strip host bind mounts from compose, keeping only named volumes.
 * When allowBindMounts is true, bind mounts are allowed but paths in
 * DENIED_MOUNT_PATHS are always blocked regardless of the flag.
 * The Docker socket has its own gate (allowDockerSocket): kept when enabled,
 * stripped otherwise — independent of allowBindMounts. (#744)
 * When stripping, returns the list of removed mounts for logging.
 */
export function sanitizeCompose(
  compose: ComposeFile,
  opts?: { allowBindMounts?: boolean; allowDockerSocket?: boolean },
): {
  compose: ComposeFile;
  strippedMounts: string[];
} {
  const strippedMounts: string[] = [];
  const sanitized = { ...compose, services: { ...compose.services } };
  for (const [name, svc] of Object.entries(sanitized.services)) {
    if (svc.volumes) {
      const safe: string[] = [];
      for (const v of svc.volumes) {
        if (!isBindMount(v)) {
          safe.push(v);
          continue;
        }

        const rawSource = v.split(":")[0];
        const mountSource = resolve(rawSource);
        // Also resolve from root to catch traversal attacks (e.g. ../../../../../../etc)
        // that would resolve differently depending on CWD depth
        const rootResolved = resolve("/", rawSource);

        // Docker socket: kept only when its own flag is on; otherwise the deploy
        // is blocked with a clear message — independent of allowBindMounts. We
        // throw rather than silently strip because a service that mounts the
        // socket needs it, and a sharp tool should fail loudly, not degrade.
        if (isDockerSocketMount(mountSource, rootResolved)) {
          if (!opts?.allowDockerSocket) {
            throw new Error(
              `Service "${name}" mounts the Docker socket "${v}" — enable the Docker Socket feature flag to allow this`,
            );
          }
          safe.push(v);
          continue;
        }

        if (opts?.allowBindMounts) {
          // Bind mounts allowed — still enforce the deny list unconditionally.
          // Throw rather than silently drop: the user explicitly configured this
          // mount, so a silent strip would cause confusing runtime behaviour.
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
      }
      sanitized.services[name] = { ...svc, volumes: safe };
    }
  }
  return { compose: sanitized, strippedMounts };
}
