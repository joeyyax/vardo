// ---------------------------------------------------------------------------
// YAML parsing and serialization for Docker Compose files.
// ---------------------------------------------------------------------------

import YAML from "yaml";
import type {
  ComposeFile,
  ComposeFileRef,
  ComposeService,
  ComposeDependsOnCondition,
  HealthCheck,
  Ulimits,
} from "./compose-types";
import {
  ALLOWED_RUNTIMES,
  normalizeNamedNetworkModes,
  parseComposeYaml,
} from "./compose-validate";
import { SHARED_MARKER } from "./slot-partition";

/**
 * Serialize a ComposeFile to a YAML string.
 */
export function composeToYaml(compose: ComposeFile): string {
  const doc: Record<string, unknown> = {};
  if (compose.name) doc.name = compose.name;

  const services: Record<string, Record<string, unknown>> = {};
  for (const [key, svc] of Object.entries(compose.services)) {
    const { name: _name, ...rest } = svc;
    services[key] = rest;
  }
  doc.services = services;

  if (compose.networks && Object.keys(compose.networks).length > 0) {
    doc.networks = compose.networks;
  }
  if (compose.volumes && Object.keys(compose.volumes).length > 0) {
    doc.volumes = compose.volumes;
  }
  if (compose.configs && Object.keys(compose.configs).length > 0) {
    doc.configs = compose.configs;
  }
  if (compose.secrets && Object.keys(compose.secrets).length > 0) {
    doc.secrets = compose.secrets;
  }

  return YAML.stringify(doc);
}

/**
 * Normalize a service's `configs:`/`secrets:` list. Entries without a `source`
 * are dropped — they reference nothing.
 */
function parseFileRefs(raw: unknown): ComposeFileRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs: ComposeFileRef[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      refs.push(entry);
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.source !== "string" || !obj.source) continue;
      const ref: Exclude<ComposeFileRef, string> = { source: obj.source };
      if (typeof obj.target === "string") ref.target = obj.target;
      if (typeof obj.uid === "string") ref.uid = obj.uid;
      if (typeof obj.gid === "string") ref.gid = obj.gid;
      if (typeof obj.mode === "number") ref.mode = obj.mode;
      refs.push(ref);
    }
  }
  return refs.length > 0 ? refs : undefined;
}

/**
 * Parse a YAML string into a ComposeFile.
 */
export function parseCompose(yamlString: string): ComposeFile {
  const parsed = parseComposeYaml(yamlString);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid compose file: root must be a YAML mapping");
  }

  const root = parsed as Record<string, unknown>;
  if (!root.services || typeof root.services !== "object") {
    throw new Error('Invalid compose file: missing or invalid "services" key');
  }

  const services: Record<string, ComposeService> = {};
  const rawServices = root.services as Record<string, Record<string, unknown>>;

  for (const [name, raw] of Object.entries(rawServices)) {
    const svc: ComposeService = { name };

    if (raw.image && typeof raw.image === "string") svc.image = raw.image;
    if (raw.build !== undefined) svc.build = raw.build as ComposeService["build"];
    if (typeof raw.restart === "string") svc.restart = raw.restart;
    if (Array.isArray(raw.ports)) svc.ports = raw.ports.map(String);
    if (Array.isArray(raw.expose)) svc.expose = raw.expose.map(String);
    if (raw.environment && typeof raw.environment === "object") {
      if (Array.isArray(raw.environment)) {
        const envMap: Record<string, string> = {};
        for (const item of raw.environment) {
          const s = String(item);
          const eq = s.indexOf("=");
          if (eq > 0) envMap[s.slice(0, eq)] = s.slice(eq + 1);
        }
        svc.environment = envMap;
      } else {
        svc.environment = raw.environment as Record<string, string>;
      }
    }
    if (raw.env_file) {
      if (Array.isArray(raw.env_file)) svc.env_file = raw.env_file.map(String);
      else if (typeof raw.env_file === "string") svc.env_file = [raw.env_file];
    }
    if (Array.isArray(raw.volumes)) svc.volumes = raw.volumes.map(String);
    if (raw.labels) {
      if (Array.isArray(raw.labels)) {
        const labelMap: Record<string, string> = {};
        for (const item of raw.labels) {
          const s = String(item);
          const eq = s.indexOf("=");
          if (eq > 0) labelMap[s.slice(0, eq)] = s.slice(eq + 1);
          else labelMap[s] = "";
        }
        svc.labels = labelMap;
      } else if (typeof raw.labels === "object") {
        svc.labels = raw.labels as Record<string, string>;
      }
    }
    // networks: accept both list form ("- internal") and map form
    // ("internal: { aliases: [pg] }"). The map form is valid Compose syntax
    // — silently dropping it used to strand services on the implicit
    // default network, which in turn caused the deploy pipeline to attach
    // them only to vardo-network. We don't preserve per-network config
    // (aliases, ipv4_address, etc.) because the rest of the pipeline treats
    // networks as flat membership, but we always materialize the network
    // references as strings so downstream transforms can reason about them.
    if (Array.isArray(raw.networks)) {
      svc.networks = raw.networks.map(String);
    } else if (raw.networks && typeof raw.networks === "object") {
      svc.networks = Object.keys(raw.networks as Record<string, unknown>);
    }
    // depends_on: array of strings or object with per-service conditions
    if (raw.depends_on) {
      if (Array.isArray(raw.depends_on)) {
        svc.depends_on = raw.depends_on.map(String);
      } else if (typeof raw.depends_on === "object") {
        // Preserve condition info (e.g. service_healthy) rather than dropping
        // to a plain string[].
        const deps: Record<string, { condition: ComposeDependsOnCondition }> = {};
        for (const [depName, conf] of Object.entries(
          raw.depends_on as Record<string, { condition?: string }>
        )) {
          const condition = (conf?.condition ?? "service_started") as ComposeDependsOnCondition;
          deps[depName] = { condition };
        }
        svc.depends_on = deps;
      }
    }
    if (raw.network_mode && typeof raw.network_mode === "string") {
      svc.network_mode = raw.network_mode;
    }
    if (raw.runtime && typeof raw.runtime === "string" && ALLOWED_RUNTIMES.includes(raw.runtime)) {
      svc.runtime = raw.runtime;
    }
    if (
      raw.deploy &&
      typeof raw.deploy === "object" &&
      !Array.isArray(raw.deploy) &&
      (
        !("resources" in raw.deploy) ||
        (typeof raw.deploy.resources === "object" && raw.deploy.resources !== null)
      )
    ) {
      svc.deploy = raw.deploy as ComposeService["deploy"];
    }
    if (typeof raw.oom_score_adj === "number") svc.oom_score_adj = raw.oom_score_adj;
    if (typeof raw.mem_reservation === "string" && raw.mem_reservation) svc.mem_reservation = raw.mem_reservation;
    if (typeof raw.cpu_shares === "number") svc.cpu_shares = raw.cpu_shares;
    if (Array.isArray(raw.cap_add)) svc.cap_add = raw.cap_add.map(String);
    if (Array.isArray(raw.cap_drop)) svc.cap_drop = raw.cap_drop.map(String);
    if (Array.isArray(raw.devices)) svc.devices = raw.devices.map(String);
    if (typeof raw.privileged === "boolean" && raw.privileged) svc.privileged = raw.privileged;
    if (Array.isArray(raw.security_opt)) svc.security_opt = raw.security_opt.map(String);
    if (typeof raw.shm_size === "string" && raw.shm_size) svc.shm_size = raw.shm_size;
    if (typeof raw.init === "boolean" && raw.init) svc.init = raw.init;
    if (Array.isArray(raw.extra_hosts)) svc.extra_hosts = raw.extra_hosts.map(String);
    if (raw.healthcheck && typeof raw.healthcheck === "object" && !Array.isArray(raw.healthcheck)) {
      svc.healthcheck = raw.healthcheck as HealthCheck;
    }
    if (raw.ulimits && typeof raw.ulimits === "object" && !Array.isArray(raw.ulimits)) {
      svc.ulimits = raw.ulimits as Ulimits;
    }
    if (typeof raw.hostname === "string" && raw.hostname) svc.hostname = raw.hostname;
    if (typeof raw.user === "string" && raw.user) svc.user = raw.user;
    if (typeof raw.stop_signal === "string" && raw.stop_signal) svc.stop_signal = raw.stop_signal;
    if (raw.entrypoint !== undefined) {
      if (Array.isArray(raw.entrypoint)) svc.entrypoint = raw.entrypoint.map(String);
      else if (typeof raw.entrypoint === "string") svc.entrypoint = raw.entrypoint;
    }
    if (raw.command !== undefined) {
      if (Array.isArray(raw.command)) svc.command = raw.command.map(String);
      else if (typeof raw.command === "string") svc.command = raw.command;
    }
    if (Array.isArray(raw.tmpfs)) svc.tmpfs = raw.tmpfs.map(String);
    else if (typeof raw.tmpfs === "string") svc.tmpfs = [raw.tmpfs];
    if (Array.isArray(raw.group_add)) svc.group_add = raw.group_add.map(String);
    // Both reference a top-level block carried through below. Dropping either
    // leaves the service pointing at a file that never gets mounted.
    const configs = parseFileRefs(raw.configs);
    if (configs) svc.configs = configs;
    const secrets = parseFileRefs(raw.secrets);
    if (secrets) svc.secrets = secrets;

    // Carried through by hand — the field list above drops unknown keys, and
    // the deploy pipeline reads the blue/green opt-out off the parsed compose.
    if (typeof raw[SHARED_MARKER] === "boolean") svc[SHARED_MARKER] = raw[SHARED_MARKER];

    // A fixed name can only belong to a service that is never duplicated, so
    // it rides along only with the shared marker. Blue and green would collide.
    if (svc[SHARED_MARKER] && typeof raw.container_name === "string") {
      svc.container_name = raw.container_name;
    }

    services[name] = svc;
  }

  const result: ComposeFile = { services };
  if (typeof root.name === "string" && root.name) result.name = root.name;
  if (root.networks && typeof root.networks === "object") {
    result.networks = root.networks as Record<string, unknown>;
  }
  if (root.volumes && typeof root.volumes === "object") {
    result.volumes = root.volumes as Record<string, unknown>;
  }
  if (root.configs && typeof root.configs === "object" && !Array.isArray(root.configs)) {
    result.configs = root.configs as Record<string, unknown>;
  }
  if (root.secrets && typeof root.secrets === "object" && !Array.isArray(root.secrets)) {
    result.secrets = root.secrets as Record<string, unknown>;
  }

  // Docker accepts network_mode with a network name and ignores it, so the
  // service silently lands on the project's default network. Correct it here
  // and every consumer — deploy, preview, analyze, import — sees the fix.
  return normalizeNamedNetworkModes(result);
}
