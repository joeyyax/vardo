// ---------------------------------------------------------------------------
// Docker Compose generation and manipulation for Host projects.
//
// NOTE: This module includes a minimal YAML serializer/parser sufficient for
// Docker Compose files. For production hardening, install `yaml` or `js-yaml`
// and swap the implementations of `composeToYaml` and `parseCompose`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComposeService = {
  name: string;
  image?: string;
  build?: string | { context: string; dockerfile?: string };
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  labels?: Record<string, string>;
  networks?: string[];
};

export type ComposeFile = {
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate a ComposeFile for a single-image project.
 * The service name is derived from the project name.
 */
export function generateComposeForImage(opts: {
  projectName: string;
  imageName: string;
  containerPort?: number;
  envVars?: Record<string, string>;
}): ComposeFile {
  const { projectName, imageName, containerPort, envVars } = opts;

  const service: ComposeService = {
    name: projectName,
    image: imageName,
  };

  if (containerPort) {
    service.ports = [`${containerPort}:${containerPort}`];
  }

  if (envVars && Object.keys(envVars).length > 0) {
    service.environment = { ...envVars };
  }

  return {
    services: {
      [projectName]: service,
    },
  };
}

// ---------------------------------------------------------------------------
// Traefik label injection
// ---------------------------------------------------------------------------

/**
 * Add Traefik reverse-proxy labels to a service in the compose file.
 * Returns a new ComposeFile -- does not mutate the original.
 */
export function injectTraefikLabels(
  compose: ComposeFile,
  opts: {
    projectName: string;
    domain: string;
    containerPort: number;
    serviceName?: string;
    certResolver?: string;
  },
): ComposeFile {
  const { projectName, domain, containerPort, certResolver = "le" } = opts;
  const serviceName =
    opts.serviceName ?? Object.keys(compose.services)[0];

  if (!serviceName || !compose.services[serviceName]) {
    throw new Error(
      `Service "${serviceName}" not found in compose file. Available: ${Object.keys(compose.services).join(", ")}`,
    );
  }

  const existing = compose.services[serviceName];
  const labels: Record<string, string> = {
    ...existing.labels,
    "traefik.enable": "true",
    [`traefik.http.routers.${projectName}.rule`]: `Host(\`${domain}\`)`,
    [`traefik.http.routers.${projectName}.entrypoints`]: "websecure",
    [`traefik.http.routers.${projectName}.tls.certresolver`]: certResolver,
    [`traefik.http.services.${projectName}.loadbalancer.server.port`]:
      String(containerPort),
  };

  const updatedService: ComposeService = { ...existing, labels };

  return {
    ...compose,
    services: {
      ...compose.services,
      [serviceName]: updatedService,
    },
  };
}

// ---------------------------------------------------------------------------
// Network injection
// ---------------------------------------------------------------------------

/**
 * Add an external network to the compose file and attach every service to it.
 * Returns a new ComposeFile -- does not mutate the original.
 */
export function injectNetwork(
  compose: ComposeFile,
  networkName: string = "host-network",
): ComposeFile {
  const updatedServices: Record<string, ComposeService> = {};
  for (const [key, svc] of Object.entries(compose.services)) {
    const existingNetworks = svc.networks ?? [];
    updatedServices[key] = {
      ...svc,
      networks: existingNetworks.includes(networkName)
        ? existingNetworks
        : [...existingNetworks, networkName],
    };
  }

  const existingNetworks = (compose.networks ?? {}) as Record<string, unknown>;

  return {
    ...compose,
    services: updatedServices,
    networks: {
      ...existingNetworks,
      [networkName]: { external: true },
    },
  };
}

// ---------------------------------------------------------------------------
// Port detection
// ---------------------------------------------------------------------------

export type PortMapping = {
  serviceName: string;
  internal: number;
  external?: number;
};

/**
 * Parse port mappings from all services in a compose file.
 *
 * Handles formats:
 *   "3000"              -> internal 3000
 *   "8080:3000"         -> external 8080, internal 3000
 *   "0.0.0.0:8080:3000" -> external 8080, internal 3000
 *   "8080:3000/tcp"     -> external 8080, internal 3000 (protocol stripped)
 */
export function detectPorts(compose: ComposeFile): PortMapping[] {
  const results: PortMapping[] = [];

  for (const [name, svc] of Object.entries(compose.services)) {
    if (!svc.ports) continue;

    for (const raw of svc.ports) {
      const mapping = parsePortString(raw);
      if (mapping) {
        results.push({ serviceName: name, ...mapping });
      }
    }
  }

  return results;
}

function parsePortString(
  raw: string,
): { internal: number; external?: number } | null {
  // Strip protocol suffix (e.g. /tcp, /udp)
  const stripped = raw.split("/")[0];
  const parts = stripped.split(":");

  if (parts.length === 1) {
    // "3000"
    const port = parseInt(parts[0], 10);
    return isNaN(port) ? null : { internal: port };
  }

  if (parts.length === 2) {
    // "8080:3000"
    const external = parseInt(parts[0], 10);
    const internal = parseInt(parts[1], 10);
    return isNaN(internal) ? null : { internal, external: isNaN(external) ? undefined : external };
  }

  if (parts.length === 3) {
    // "0.0.0.0:8080:3000"
    const external = parseInt(parts[1], 10);
    const internal = parseInt(parts[2], 10);
    return isNaN(internal) ? null : { internal, external: isNaN(external) ? undefined : external };
  }

  return null;
}

// ---------------------------------------------------------------------------
// YAML serialization (minimal, sufficient for Docker Compose)
// ---------------------------------------------------------------------------

/**
 * Serialize a ComposeFile to a YAML string.
 */
export function composeToYaml(compose: ComposeFile): string {
  const doc: Record<string, unknown> = {};

  // Convert services: strip `name` field (it is the key, not a compose property)
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

  return serializeYaml(doc, 0);
}

function serializeYaml(value: unknown, indent: number): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    // Quote strings that contain special chars or could be misread
    if (
      value === "" ||
      value.includes(":") ||
      value.includes("#") ||
      value.includes("{") ||
      value.includes("}") ||
      value.includes("[") ||
      value.includes("]") ||
      value.includes("&") ||
      value.includes("*") ||
      value.includes("!") ||
      value.includes("|") ||
      value.includes(">") ||
      value.includes("'") ||
      value.includes('"') ||
      value.includes("`") ||
      value.includes(",") ||
      value.includes("@") ||
      value.includes("%") ||
      value.startsWith(" ") ||
      value.endsWith(" ") ||
      value === "true" ||
      value === "false" ||
      value === "null" ||
      value === "yes" ||
      value === "no" ||
      /^\d+$/.test(value)
    ) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const pad = "  ".repeat(indent);
  const childPad = "  ".repeat(indent + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const lines = value.map((item) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const obj = serializeYamlObject(item as Record<string, unknown>, indent + 2);
        // First key goes on the same line as the dash
        const firstNewline = obj.indexOf("\n");
        if (firstNewline === -1) {
          return `${pad}- ${obj.trimStart()}`;
        }
        return `${pad}- ${obj.trimStart()}`;
      }
      return `${pad}- ${serializeYaml(item, indent + 1)}`;
    });
    return "\n" + lines.join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";

    const lines = keys.map((key) => {
      const val = obj[key];
      if (
        typeof val === "object" &&
        val !== null &&
        !Array.isArray(val) &&
        Object.keys(val).length > 0
      ) {
        return `${childPad}${key}:${serializeYaml(val, indent + 1)}`;
      }
      if (Array.isArray(val)) {
        return `${childPad}${key}:${serializeYaml(val, indent + 1)}`;
      }
      return `${childPad}${key}: ${serializeYaml(val, indent + 1)}`;
    });
    return "\n" + lines.join("\n");
  }

  return String(value);
}

function serializeYamlObject(
  obj: Record<string, unknown>,
  indent: number,
): string {
  const pad = "  ".repeat(indent);
  return Object.entries(obj)
    .map(([k, v]) => `${pad}${k}: ${serializeYaml(v, indent)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// YAML parsing (minimal -- handles standard Docker Compose structure)
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string into a ComposeFile.
 * Validates that the result contains a `services` key.
 *
 * This is a minimal parser sufficient for well-formatted Docker Compose YAML.
 * For complex YAML features (anchors, merge keys, multi-line scalars), install
 * `yaml` or `js-yaml`.
 */
export function parseCompose(yamlString: string): ComposeFile {
  const parsed = parseYaml(yamlString);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid compose file: root must be a YAML mapping");
  }

  const root = parsed as Record<string, unknown>;
  if (!root.services || typeof root.services !== "object") {
    throw new Error(
      'Invalid compose file: missing or invalid "services" key',
    );
  }

  // Reconstruct typed ComposeFile
  const services: Record<string, ComposeService> = {};
  const rawServices = root.services as Record<string, Record<string, unknown>>;

  for (const [name, raw] of Object.entries(rawServices)) {
    const svc: ComposeService = { name };

    if (raw.image && typeof raw.image === "string") {
      svc.image = raw.image;
    }
    if (raw.build !== undefined) {
      svc.build = raw.build as ComposeService["build"];
    }
    if (Array.isArray(raw.ports)) {
      svc.ports = raw.ports.map(String);
    }
    if (raw.environment && typeof raw.environment === "object") {
      svc.environment = raw.environment as Record<string, string>;
    }
    if (Array.isArray(raw.volumes)) {
      svc.volumes = raw.volumes.map(String);
    }
    if (raw.labels && typeof raw.labels === "object") {
      svc.labels = raw.labels as Record<string, string>;
    }
    if (Array.isArray(raw.networks)) {
      svc.networks = raw.networks.map(String);
    }

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

// Minimal YAML parser -- handles mappings, sequences, scalars, quoted strings
function parseYaml(input: string): unknown {
  const lines = input.split("\n");
  const { value } = parseYamlLines(lines, 0, 0);
  return value;
}

function parseYamlLines(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): { value: unknown; nextIndex: number } {
  // Skip empty lines and comments to find the first meaningful line
  let i = startIndex;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    break;
  }

  if (i >= lines.length) {
    return { value: null, nextIndex: i };
  }

  const firstLine = lines[i];
  const trimmedFirst = firstLine.trim();

  // Detect if this is a sequence
  if (trimmedFirst.startsWith("- ")) {
    return parseYamlSequence(lines, i, getIndent(firstLine));
  }

  // Otherwise treat as mapping
  return parseYamlMapping(lines, i, getIndent(firstLine));
}

function parseYamlMapping(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): { value: Record<string, unknown>; nextIndex: number } {
  const result: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) break; // belongs to a child

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.substring(0, colonIdx).trim();
    const afterColon = trimmed.substring(colonIdx + 1).trim();

    if (afterColon === "" || afterColon === "|" || afterColon === ">") {
      // Value is on subsequent indented lines
      i++;
      if (i < lines.length) {
        const nextNonEmpty = findNextNonEmpty(lines, i);
        if (nextNonEmpty < lines.length) {
          const childIndent = getIndent(lines[nextNonEmpty]);
          if (childIndent > baseIndent) {
            const child = parseYamlLines(lines, nextNonEmpty, childIndent);
            result[key] = child.value;
            i = child.nextIndex;
            continue;
          }
        }
      }
      result[key] = null;
    } else {
      result[key] = parseYamlScalar(afterColon);
      i++;
    }
  }

  return { value: result, nextIndex: i };
}

function parseYamlSequence(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): { value: unknown[]; nextIndex: number } {
  const result: unknown[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) break;

    if (!trimmed.startsWith("- ")) break;

    const itemContent = trimmed.substring(2).trim();

    // Check if item content contains a colon (inline mapping start)
    const colonIdx = itemContent.indexOf(":");
    if (colonIdx > 0 && !itemContent.startsWith('"') && !itemContent.startsWith("'")) {
      // This could be a mapping item -- check for child lines
      const itemKey = itemContent.substring(0, colonIdx).trim();
      const itemVal = itemContent.substring(colonIdx + 1).trim();
      const mapping: Record<string, unknown> = {};
      mapping[itemKey] = itemVal === "" ? null : parseYamlScalar(itemVal);

      // Look for additional mapping keys at deeper indent
      i++;
      while (i < lines.length) {
        const childLine = lines[i];
        const childTrimmed = childLine.trim();
        if (childTrimmed === "" || childTrimmed.startsWith("#")) {
          i++;
          continue;
        }
        const childIndent = getIndent(childLine);
        if (childIndent <= indent) break;
        const childColon = childTrimmed.indexOf(":");
        if (childColon > 0) {
          const ck = childTrimmed.substring(0, childColon).trim();
          const cv = childTrimmed.substring(childColon + 1).trim();
          mapping[ck] = cv === "" ? null : parseYamlScalar(cv);
        }
        i++;
      }
      result.push(mapping);
    } else {
      result.push(parseYamlScalar(itemContent));
      i++;
    }
  }

  return { value: result, nextIndex: i };
}

function parseYamlScalar(value: string): unknown {
  if (value === "null" || value === "~") return null;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;

  // Quoted strings
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  // Numbers
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

  // Inline object: {external: true}
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return {};
    const obj: Record<string, unknown> = {};
    // Simple single-level inline parsing
    const pairs = inner.split(",");
    for (const pair of pairs) {
      const ci = pair.indexOf(":");
      if (ci > 0) {
        const k = pair.substring(0, ci).trim();
        const v = pair.substring(ci + 1).trim();
        obj[k] = parseYamlScalar(v);
      }
    }
    return obj;
  }

  // Strip inline comments
  const commentIdx = value.indexOf(" #");
  if (commentIdx > 0) {
    return parseYamlScalar(value.substring(0, commentIdx).trim());
  }

  return value;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function findNextNonEmpty(lines: string[], start: number): number {
  let i = start;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) return i;
    i++;
  }
  return i;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PORT_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:)?(\d+:)?\d+(\/\w+)?$/;

/**
 * Basic validation of a ComposeFile structure.
 */
export function validateCompose(compose: ComposeFile): {
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
  }

  return { valid: errors.length === 0, errors };
}
