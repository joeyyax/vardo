// Compose file validation, sanitization and cycle detection.

import { resolve } from "path";
import YAML from "yaml";
import type { ComposeFile, ComposeService, ValidateOptions } from "./compose-types";
import { dependsOnKeys } from "./compose-types";
import { SHARED_MARKER, isSharedService, nonRotatingServices } from "./slot-partition";
import { declaredVolumes, slotIndependentMounts, volumeSharedServices } from "./volume-shared";
import { getTraefikRoutedServices } from "./compose-inject";
import { selectRoutedService } from "./routed-service";

export const ALLOWED_NETWORK_MODES = ["host", "bridge", "none", "service", "container"];
export const ALLOWED_RUNTIMES = ["runc", "nvidia", "sysbox"];

/**
 * Parse compose YAML with `<<` merge keys resolved, as Docker does; YAML 1.2 leaves them nested.
 * Throws on unresolvable merge sources.
 */
export function parseComposeYaml(yamlText: string): unknown {
  return YAML.parse(yamlText, { merge: true });
}

/**
 * Whether network_mode names a namespace. Docker silently ignores a network name here
 * and puts the service on the project's default network.
 */
export function isSpecialNetworkMode(nm: string): boolean {
  return ALLOWED_NETWORK_MODES.some((p) => nm === p || nm.startsWith(p + ":"));
}

/** Services whose network_mode names a network. Takes raw YAML to audit stored config. */
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
 * Rewrite `network_mode: <network name>` as membership of that network, declared external
 * so Compose doesn't create a project-prefixed copy. Special modes are left alone.
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

const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*$/;
// Literal digits or ${VAR:-default}.
const PORT_VAL = String.raw`(?:\d+|\$\{[^}]+\})`;
const PORT_RE = new RegExp(
  String.raw`^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:)?` +
  String.raw`(${PORT_VAL}:)?` +
  String.raw`${PORT_VAL}` +
  String.raw`(\/\w+)?$`,
);

// Shared with the backup engine. See lib/docker/mount-paths.ts.
import { DENIED_MOUNT_PATHS } from "./mount-paths";

/** True for a 64-char hex (or empty) Docker mount name. */
export function isAnonymousVolume(name: string): boolean {
  return !name || /^[0-9a-f]{64}$/.test(name);
}

/** True if a compose volume entry is a host bind mount. A bare "/data" is an anonymous volume. */
function isBindMount(vol: string): boolean {
  return (
    vol.startsWith("./") ||
    vol.startsWith("../") ||
    (vol.startsWith("/") && vol.includes(":"))
  );
}

// /var/run is usually a symlink to /run.
const DOCKER_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock"];

/**
 * True if a bind-mount source is the host Docker socket. Checks the cwd- and root-resolved
 * forms so a `../` traversal can't slip past the gate. (#744)
 */
function isDockerSocketMount(mountSource: string, rootResolved: string): boolean {
  return (
    DOCKER_SOCKET_PATHS.includes(mountSource) ||
    DOCKER_SOCKET_PATHS.includes(rootResolved)
  );
}

/** Names the setting that unblocks the mount and who can turn it on. */
function dockerSocketBlockedMessage(service: string, volume: string): string {
  return (
    `Service "${service}" mounts the Docker socket "${volume}" — turn on ` +
    `"Allow Docker socket" in the project's settings to allow this ` +
    `(organization admins and owners only)`
  );
}

/** Services a deploy will route through Traefik, resolved as swap.ts does. Guessed picks are dropped. */
function routedServiceNames(compose: ComposeFile): string[] {
  const labeled = getTraefikRoutedServices(compose);
  if (labeled.size > 0) return [...labeled];
  const selection = selectRoutedService(compose);
  return selection.service && !selection.ambiguous ? [selection.service] : [];
}

/** Misuses of x-vardo-shared, caught before a deploy runs. */
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

/** Services marked x-vardo-shared, from raw compose YAML. */
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
 * Whether a dropped marker could have meant "shared". A dropped true puts two databases
 * on one volume.
 */
export function sharedMarkerIsHazardous(value: unknown): boolean {
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !FALSY_SPELLINGS.has(value.trim().toLowerCase());
  return true;
}

/**
 * Services setting x-vardo-shared to a non-boolean, which parseCompose drops. Takes raw YAML;
 * after parsing, a quoted marker and an absent one look the same.
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

/** Blocking errors for markers that could have meant "shared". Run before storing raw compose. */
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

/** Service keys parseCompose carries through. */
const PARSED_SERVICE_KEYS = new Set([
  "image", "build", "restart", "ports", "expose", "environment", "env_file",
  "volumes", "labels", "networks", "depends_on", "network_mode", "runtime",
  "deploy", "oom_score_adj", "mem_reservation", "memswap_limit", "cpu_shares", "cap_add",
  "cap_drop", "devices", "privileged", "security_opt", "shm_size", "init",
  "extra_hosts", "healthcheck", "ulimits", "hostname", "user", "stop_signal",
  "entrypoint", "command", "tmpfs", "group_add", "container_name", "configs",
  "secrets", "mem_limit", "cpus", "pids_limit", "read_only", "stdin_open", "tty", "working_dir",
  "dns", "dns_search", "dns_opt", "sysctls", "pull_policy", "stop_grace_period",
  SHARED_MARKER,
]);

/** Valid Compose service keys Docker honors and Vardo drops. */
const DROPPED_SERVICE_KEYS = new Set([
  "cpu_count", "cpu_percent", "cpuset",
  "mem_swappiness", "blkio_config", "device_cgroup_rules",
  "logging", "profiles", "platform", "domainname", "userns_mode", "ipc", "pid",
  "uts", "cgroup", "cgroup_parent", "isolation", "storage_opt", "annotations",
  "attach", "links", "external_links", "volumes_from", "label_file",
  "post_start", "pre_stop", "credential_spec", "scale", "develop", "provider",
  "extends",
]);

/**
 * Report Compose keys Docker honors and Vardo drops.
 * Adding a key to the parser means removing it here too.
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

/** Report services Vardo stops rotating because a second copy would land on their data directory. */
export function unmarkedSharedVolumeWarnings(compose: ComposeFile): string[] {
  const declared = declaredVolumes(compose);
  const nonRotating = nonRotatingServices(compose);

  const detected = volumeSharedServices(compose);
  const dataOnly = Object.entries(compose.services).every(
    ([name, svc]) => isSharedService(svc) || detected.has(name),
  );

  const warnings: string[] = [];
  for (const name of detected) {
    const svc = compose.services[name];
    if (isSharedService(svc)) continue;
    const mounts = slotIndependentMounts(svc.volumes, declared).map((v) => `"${v}"`).join(", ");
    const head = `Service "${name}" runs ${svc.image} and mounts ${mounts}, which both slots address.`;

    // Not in nonRotating: it still rotates.
    warnings.push(
      nonRotating.has(name)
        ? `${head} Vardo will deploy it once instead of rotating it — ` +
            `add ${SHARED_MARKER}: true to say so in the compose file.`
        : dataOnly
          ? `${head} Each deploy stops the old copy before starting the new one, ` +
              `so it is briefly down while it restarts.`
          : `${head} Vardo cannot take it out of the rotation, so each deploy stops the ` +
              `old slot before starting the new one and the app is briefly down. Give it ` +
              `its own compose file, or drop the depends_on tying it to a service that rotates.`,
    );
  }
  return warnings;
}

/** Basic validation of a ComposeFile structure. */
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
    if (!SERVICE_NAME_RE.test(name)) {
      errors.push(
        `Service name "${name}" is invalid (must be lowercase alphanumeric with hyphens, starting with a letter)`,
      );
    }

    if (!svc.image && !svc.build) {
      errors.push(`Service "${name}" must have either "image" or "build"`);
    }

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
            errors.push(dockerSocketBlockedMessage(name, vol));
          }
          continue;
        }

        if (!opts?.allowBindMounts) {
          errors.push(
            `Service "${name}" uses host bind mount "${vol}" — enable the Bind Mounts feature flag to allow this`,
          );
          continue;
        }

        // The rest of the deny-list stays enforced.
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

  // Multi-hop cycles in service:X network_mode references.
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
      // Already reported.
      if (!next || !compose.services[next] || next === node) break;

      if (seen.has(next)) {
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

  // Docker rejects network_mode chains; the target must own its namespace.
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
 * Strip host bind mounts, keeping named volumes. DENIED_MOUNT_PATHS stay blocked even with
 * allowBindMounts; the Docker socket has its own gate. (#744)
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
        // Resolve from root too, to catch `../` traversal.
        const rootResolved = resolve("/", rawSource);

        // Socket kept only when its own flag is on; otherwise the deploy fails.
        if (isDockerSocketMount(mountSource, rootResolved)) {
          if (!opts?.allowDockerSocket) {
            throw new Error(dockerSocketBlockedMessage(name, v));
          }
          safe.push(v);
          continue;
        }

        if (opts?.allowBindMounts) {
          // Deny list is enforced unconditionally.
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

/** Each service's settings that reach past the container boundary to the host. */
export function hostAccessSettings(compose: ComposeFile): { service: string; used: string[] }[] {
  const out: { service: string; used: string[] }[] = [];
  for (const [name, svc] of Object.entries(compose.services)) {
    const used: string[] = [];
    if (svc.privileged) used.push("privileged");
    if (svc.cap_add?.length) used.push("cap_add");
    if (svc.devices?.length) used.push("devices");
    // no-new-privileges only narrows the container; Vardo sets it for these orgs anyway.
    if (svc.security_opt?.some((o) => !/^no-new-privileges(:true)?$/.test(o))) used.push("security_opt");
    const nm = svc.network_mode;
    if (nm === "host" || nm?.startsWith("container:")) used.push(`network_mode: ${nm}`);
    if (used.length > 0) out.push({ service: name, used });
  }
  return out;
}

/** Host-access refusals for an untrusted organization. */
export function hostAccessErrors(compose: ComposeFile): string[] {
  return hostAccessSettings(compose).map(
    ({ service, used }) =>
      `Service "${service}" uses ${used.join(", ")}, which only a trusted organization can deploy. An instance admin can mark the organization trusted under Admin → Organizations.`,
  );
}
