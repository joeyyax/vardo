// ---------------------------------------------------------------------------
// YAML parsing and serialization for Docker Compose files.
// ---------------------------------------------------------------------------

import YAML from "yaml";
import type {
  ComposeFile,
  ComposeService,
  ComposeDependsOnCondition,
  HealthCheck,
  Ulimits,
} from "./compose-types";
import {
  ALLOWED_NETWORK_MODES,
  ALLOWED_RUNTIMES,
} from "./compose-validate";

/**
 * Serialize a ComposeFile to a YAML string.
 */
export function composeToYaml(compose: ComposeFile): string {
  const doc: Record<string, unknown> = {};

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

  return YAML.stringify(doc);
}

/**
 * Parse a YAML string into a ComposeFile.
 */
export function parseCompose(yamlString: string): ComposeFile {
  const parsed = YAML.parse(yamlString);

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
    if (Array.isArray(raw.networks)) svc.networks = raw.networks.map(String);
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
      const nm = raw.network_mode;
      if (ALLOWED_NETWORK_MODES.some((p) => nm === p || nm.startsWith(p + ":"))) {
        svc.network_mode = nm;
      }
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

    services[name] = svc;
  }

  const result: ComposeFile = { services };
  if (root.networks && typeof root.networks === "object") {
    result.networks = root.networks as Record<string, unknown>;
  }
  if (root.volumes && typeof root.volumes === "object") {
    result.volumes = root.volumes as Record<string, unknown>;
  }

  return result;
}
