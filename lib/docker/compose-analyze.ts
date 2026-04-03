// ---------------------------------------------------------------------------
// Compose analysis — inspects a ComposeFile and returns structured findings.
//
// Pure function, no side effects. Used by:
// - The normalize step (to decide what to transform)
// - The analysis API (to surface findings to the UI)
// - The import-time review dialog (to show users what Vardo will change)
// ---------------------------------------------------------------------------

import YAML from "yaml";
import type { ComposeFile } from "./compose";
import { parsePortString, parseCompose } from "./compose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingSeverity = "info" | "warning" | "critical";

export type FindingCategory =
  | "host-port"
  | "container-name"
  | "restart-policy"
  | "inline-env"
  | "env-var-ref";

export type Finding = {
  /** Which category this finding belongs to. */
  category: FindingCategory;
  /** How important this is. */
  severity: FindingSeverity;
  /** Which compose service this applies to (null = file-level). */
  service: string | null;
  /** Short human-readable summary. */
  message: string;
  /** Machine-readable details for the normalize step and UI. */
  detail: Record<string, unknown>;
  /** Whether the normalizer will auto-fix this. */
  autoFixed: boolean;
};

export type ComposeAnalysis = {
  findings: Finding[];
  /** Convenience counts by category. */
  counts: Record<FindingCategory, number>;
};

// Well-known ports that are almost certainly HTTP and safe to strip
// when Traefik is routing. Ports outside this set get a warning instead
// of auto-fix.
const COMMON_HTTP_PORTS = new Set([
  80, 443, 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8443, 8888, 9000,
]);

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

export function analyzeCompose(
  compose: ComposeFile,
  opts: {
    /** Services that have domains (Traefik-routed). */
    routedServices?: Set<string>;
    /** Env var keys already managed by Vardo. */
    managedEnvKeys?: Set<string>;
  } = {},
): ComposeAnalysis {
  const findings: Finding[] = [];
  const routedServices = opts.routedServices ?? new Set<string>();
  const managedEnvKeys = opts.managedEnvKeys ?? new Set<string>();

  for (const [name, svc] of Object.entries(compose.services)) {
    analyzeHostPorts(name, svc, routedServices, findings);
    // container_name is dropped by the parser — pass undefined for parsed compose
    analyzeContainerName(name, undefined, findings);
    analyzeRestartPolicy(name, svc, findings);
    analyzeEnvironment(name, svc, managedEnvKeys, findings);
  }

  // Build counts
  const counts = {} as Record<FindingCategory, number>;
  for (const f of findings) {
    counts[f.category] = (counts[f.category] || 0) + 1;
  }

  return { findings, counts };
}

// ---------------------------------------------------------------------------
// Individual analyzers
// ---------------------------------------------------------------------------

function analyzeHostPorts(
  name: string,
  svc: ComposeFile["services"][string],
  routedServices: Set<string>,
  findings: Finding[],
): void {
  if (!svc.ports) return;

  for (const raw of svc.ports) {
    const parsed = parsePortString(raw);
    if (!parsed || parsed.external === undefined) continue;

    const isRouted = routedServices.has(name);
    const isCommonHttp = COMMON_HTTP_PORTS.has(parsed.internal);

    if (isRouted) {
      findings.push({
        category: "host-port",
        severity: "info",
        service: name,
        message: `Host port ${parsed.external}:${parsed.internal} will be removed — Traefik handles routing for this service`,
        detail: { port: raw, internal: parsed.internal, external: parsed.external, routed: true },
        autoFixed: true,
      });
    } else if (isCommonHttp) {
      findings.push({
        category: "host-port",
        severity: "warning",
        service: name,
        message: `Host port ${parsed.external}:${parsed.internal} detected — this may conflict with other services. Add a domain to route through Traefik instead`,
        detail: { port: raw, internal: parsed.internal, external: parsed.external, routed: false },
        autoFixed: false,
      });
    }
    // Non-HTTP ports on non-routed services (databases, etc.) are fine — no finding
  }
}

/**
 * Analyze container_name directives.
 *
 * Note: the compose parser already drops container_name (it's not in the
 * ComposeService type). This analyzer works on RAW YAML (pre-parse) via
 * analyzeRawCompose(), or on parsed compose where the field is already gone.
 * Included for completeness in raw analysis.
 */
function analyzeContainerName(
  name: string,
  containerName: string | undefined,
  findings: Finding[],
): void {
  if (!containerName) return;

  findings.push({
    category: "container-name",
    severity: "info",
    service: name,
    message: `container_name "${containerName}" will be removed — Vardo manages container names for blue-green deploys`,
    detail: { containerName },
    autoFixed: true,
  });
}

function analyzeRestartPolicy(
  name: string,
  svc: ComposeFile["services"][string],
  findings: Finding[],
): void {
  if (!svc.restart) {
    findings.push({
      category: "restart-policy",
      severity: "info",
      service: name,
      message: `No restart policy — will be set to "unless-stopped"`,
      detail: { current: undefined, normalized: "unless-stopped" },
      autoFixed: true,
    });
    return;
  }

  // "no" and "always" are usually not what you want in a managed environment
  if (svc.restart === "no") {
    findings.push({
      category: "restart-policy",
      severity: "warning",
      service: name,
      message: `restart: "no" will be changed to "unless-stopped" — services should restart on failure in production`,
      detail: { current: "no", normalized: "unless-stopped" },
      autoFixed: true,
    });
  }
}

function analyzeEnvironment(
  name: string,
  svc: ComposeFile["services"][string],
  managedEnvKeys: Set<string>,
  findings: Finding[],
): void {
  if (!svc.environment) return;

  for (const [key, value] of Object.entries(svc.environment)) {
    // Skip variable references — these are intentional compose-level refs
    if (typeof value === "string" && /\$\{?[A-Z_]/.test(value)) {
      continue;
    }

    // Skip empty values
    if (value === "" || value === undefined) continue;

    if (managedEnvKeys.has(key)) {
      // Already managed by Vardo — the inline value will drift
      findings.push({
        category: "inline-env",
        severity: "warning",
        service: name,
        message: `"${key}" is already managed as a Vardo env var — inline value will be ignored`,
        detail: { key, value, managed: true },
        autoFixed: false,
      });
    } else {
      // Candidate for extraction
      findings.push({
        category: "inline-env",
        severity: "info",
        service: name,
        message: `"${key}" could be managed as a Vardo env var (encrypted, per-environment)`,
        detail: { key, value, managed: false },
        autoFixed: false,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Raw YAML analysis (pre-parse)
// ---------------------------------------------------------------------------

/**
 * Analyze raw compose YAML before parsing. Catches things the parser drops
 * (like container_name) so the UI can show what will happen.
 */
export function analyzeRawCompose(
  yamlContent: string,
  opts: {
    routedServices?: Set<string>;
    managedEnvKeys?: Set<string>;
  } = {},
): ComposeAnalysis {
  // Parse to get the typed compose for standard analysis
  const compose = parseCompose(yamlContent);
  const analysis = analyzeCompose(compose, opts);

  // Also check the raw YAML for fields the parser drops
  try {
    const raw = YAML.parse(yamlContent);
    if (raw?.services && typeof raw.services === "object") {
      for (const [name, svc] of Object.entries(raw.services as Record<string, Record<string, unknown>>)) {
        if (typeof svc?.container_name === "string") {
          analyzeContainerName(name, svc.container_name, analysis.findings);
          analysis.counts["container-name"] = (analysis.counts["container-name"] || 0) + 1;
        }
      }
    }
  } catch {
    // If raw parse fails, the standard analysis is still valid
  }

  return analysis;
}
