// What each shared container was created from, so a deploy can tell a label or weight change from a real one.
// Compose's config hash covers everything; these fingerprints skip what never needs a recreate.

import { createHash } from "crypto";
import { readFile, rename, writeFile } from "fs/promises";

/** Keys a fingerprint skips: labels, scheduling weights and keys compose leaves out of its own hash. */
const SKIPPED_KEYS = ["labels", "cpu_shares", "oom_score_adj", "mem_reservation", "profiles", "build", "pull_policy", "depends_on"];

/** In the app's environment dir, beside the slots. */
export const SHARED_DEFINITIONS_FILE = "shared-definitions.json";

export type DefinitionRecord ={ hash: string; fingerprint: string };
export type DefinitionRecords = Record<string, DefinitionRecord>;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Sorted keys, without nulls and empty objects or lists. */
function canonical(value: unknown): Json | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((v): v is Json => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      const v = canonical((value as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value as Json;
}

/**
 * A service from `config --format json`, blind to labels and scheduling weights.
 * Limits count by value however they're written; networks count by name.
 */
export function definitionFingerprint(service: Record<string, unknown>): string {
  const s: Record<string, unknown> = { ...service };
  for (const key of SKIPPED_KEYS) delete s[key];

  const deploy = { ...((s.deploy ?? {}) as Record<string, unknown>) };
  const resources = (deploy.resources ?? {}) as { limits?: Record<string, unknown>; reservations?: Record<string, unknown> };
  delete deploy.resources;
  const limits = resources.limits ?? {};
  const asString = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
  s.limits = {
    memory: asString(limits.memory ?? s.mem_limit),
    cpus: asString(limits.cpus ?? s.cpus),
    pids: asString(limits.pids ?? s.pids_limit),
  };
  s.reserved_devices = resources.reservations?.devices;
  s.deploy = deploy;
  delete s.mem_limit;
  delete s.cpus;
  delete s.pids_limit;

  if (s.networks && typeof s.networks === "object" && !Array.isArray(s.networks)) {
    s.networks = Object.keys(s.networks).sort();
  }

  return createHash("sha256").update(JSON.stringify(canonical(s) ?? {})).digest("hex");
}

/** Fingerprints by service from `config --format json` output. Empty when it doesn't parse. */
export function fingerprintsFromConfig(output: string): Map<string, string> {
  const fingerprints = new Map<string, string>();
  try {
    const services = (JSON.parse(output) as { services?: Record<string, Record<string, unknown>> }).services ?? {};
    for (const [name, service] of Object.entries(services)) fingerprints.set(name, definitionFingerprint(service));
  } catch {
    // Not JSON; nothing to compare.
  }
  return fingerprints;
}

export async function loadDefinitions(file: string): Promise<DefinitionRecords> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as { services?: DefinitionRecords };
    return parsed.services ?? {};
  } catch {
    return {};
  }
}

export async function saveDefinitions(file: string, services: DefinitionRecords): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ services }, null, 2)}\n`, "utf-8");
  await rename(tmp, file);
}
