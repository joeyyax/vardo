// The files a slot directory hands to `docker compose`: the bare compose, Vardo's overlay and the env files.

import { access, readFile, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";

/** Vardo's overlay, layered over the slot's docker-compose.yml. */
export const SLOT_OVERLAY_FILE = "docker-compose.override.yml";

/** Vardo's overlay name before April 2026. A repo can ship a file by this name too. */
export const LEGACY_OVERLAY_FILE = "docker-compose.vardo.yml";

/** Variables Vardo sets for compose interpolation only. Never reaches a container. */
export const SLOT_VARS_FILE = ".vardo.env";

/** Value of the commit variables when the deploy has no git commit. */
export const NO_GIT_SHA = "local";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Compose interpolation variables for a deploy's commit. */
export function slotVars(gitSha: string | null | undefined): Record<string, string> {
  const sha = gitSha && SHA_RE.test(gitSha) ? gitSha.toLowerCase() : null;
  return {
    VARDO_GIT_SHA: sha ?? NO_GIT_SHA,
    VARDO_GIT_SHORT_SHA: sha ? sha.slice(0, 7) : NO_GIT_SHA,
  };
}

/** Write the slot's interpolation variables. */
export async function writeSlotVars(slotDir: string, gitSha: string | null | undefined): Promise<void> {
  const content = Object.entries(slotVars(gitSha)).map(([k, v]) => `${k}=${v}\n`).join("");
  await writeFile(join(slotDir, SLOT_VARS_FILE), content, "utf-8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `--env-file` arguments for a slot: its `.env`, then Vardo's variables. Empty for a slot from before them. */
export async function slotEnvFileArgs(slotDir: string): Promise<string[]> {
  const vars = join(slotDir, SLOT_VARS_FILE);
  if (!(await exists(vars))) return [];
  const dotenv = join(slotDir, ".env");
  // An explicit --env-file stops compose reading .env itself.
  return [...((await exists(dotenv)) ? ["--env-file", dotenv] : []), "--env-file", vars];
}

/** Whether a legacy overlay's YAML is one Vardo wrote: labels, networks and limits only, on vardo-network. */
export function isVardoLegacyOverlay(content: string): boolean {
  let doc: unknown;
  try {
    doc = YAML.parse(content);
  } catch {
    return false;
  }
  if (!isRecord(doc) || !isRecord(doc.services)) return false;
  if (!Object.keys(doc).every((k) => ["services", "networks", "volumes"].includes(k))) return false;
  const network = isRecord(doc.networks) ? doc.networks["vardo-network"] : undefined;
  if (!isRecord(network) || network.external !== true) return false;

  return Object.values(doc.services).every((svc) => {
    if (svc === null) return true;
    if (!isRecord(svc)) return false;
    if (!Object.keys(svc).every((k) => ["labels", "networks", "deploy"].includes(k))) return false;
    if (svc.labels === undefined) return true;
    return isRecord(svc.labels) && Object.keys(svc.labels).every((k) => k.startsWith("traefik.") || k.startsWith("vardo."));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function legacyOverlay(slotDir: string): Promise<string | null> {
  const path = join(slotDir, LEGACY_OVERLAY_FILE);
  try {
    return isVardoLegacyOverlay(await readFile(path, "utf-8")) ? path : null;
  } catch {
    return null;
  }
}

/** Compose file and env-file arguments for a slot directory. */
export async function slotComposeFiles(slotDir: string): Promise<string[]> {
  const base = join(slotDir, "docker-compose.yml");
  const envArgs = await slotEnvFileArgs(slotDir);
  const legacy = await legacyOverlay(slotDir);
  if (legacy) return ["-f", base, "-f", legacy, ...envArgs];
  // Compose skips docker-compose.override.yml when -f is passed.
  const override = join(slotDir, SLOT_OVERLAY_FILE);
  if (await exists(override)) return ["-f", base, "-f", override, ...envArgs];
  return ["-f", base, ...envArgs];
}
