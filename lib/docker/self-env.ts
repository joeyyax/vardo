import { chmod, copyFile, readFile, realpath, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";
import { VARDO_HOME_DIR } from "@/lib/paths";
import { APP_UID, DOCKER_CLEANUP_TIMEOUT } from "./constants";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

/** The instance's settings file, `$VARDO_HOME_DIR/.env`. Mounted at the same path inside the container. */
export const GLOBAL_ENV_PATH = join(VARDO_HOME_DIR, ".env");

/** Keys that identify a slot or its build. The previous slot's value wins over the global file. */
export const SLOT_OWNED_KEYS: ReadonlySet<string> = new Set(["COMPOSE_PROJECT_NAME", "GIT_SHA"]);

/** The self-app is the only app whose env lives on the host, not in the database. */
export function isSelfApp(appName: string): boolean {
  return appName === VARDO_SELF_APP_NAME;
}

export interface SeedSelfEnvOptions {
  log: (line: string) => void;
  globalEnvPath?: string;
}

/**
 * Build the new self-app slot's `.env` from the global file, layered with slot-owned keys from the previous slot.
 * Returns a description of the sources, or null when there was nothing to seed from.
 */
export async function seedSelfEnv(
  appName: string,
  appDir: string,
  slotDir: string,
  activeSlot: string | null,
  { log, globalEnvPath = GLOBAL_ENV_PATH }: SeedSelfEnvOptions,
): Promise<string | null> {
  if (!isSelfApp(appName)) return null;

  const target = join(slotDir, ".env");
  const previous = await copyPreviousSlotEnv(appDir, activeSlot, target);
  const globalContent = await readEnvFile(globalEnvPath);

  if (globalContent === null) {
    if (previous) log(`[deploy] Warning: could not read ${globalEnvPath} — using the previous slot's .env unchanged`);
    return previous;
  }

  const previousContent = previous ? await readFile(target, "utf-8") : "";
  const merged = mergeSelfEnv(globalContent, previousContent);
  await writeFile(target, merged.content, { encoding: "utf-8", mode: 0o600 });
  await chmod(target, 0o600);

  if (previous) {
    for (const key of merged.changed) {
      log(`[deploy] .env: ${key} differs from the previous slot — using ${globalEnvPath}`);
    }
    if (merged.added.length > 0) {
      log(`[deploy] .env: added from ${globalEnvPath}: ${merged.added.join(", ")}`);
    }
    if (merged.carried.length > 0) {
      log(`[deploy] .env: kept from the previous slot, missing from ${globalEnvPath}: ${merged.carried.join(", ")}`);
    }
  }

  return previous ? `${globalEnvPath} (slot keys from ${previous})` : globalEnvPath;
}

export interface MergedSelfEnv {
  content: string;
  /** Keys in both files with different values, where the global value won. */
  changed: string[];
  /** Keys only in the global file. */
  added: string[];
  /** Non-slot-owned keys only in the previous slot, carried forward. */
  carried: string[];
}

/** Global `.env` as the base; the previous slot supplies slot-owned keys and keys the global file lacks. */
export function mergeSelfEnv(globalContent: string, previousContent: string): MergedSelfEnv {
  const globalEntries = parseEnvLines(globalContent);
  const previousEntries = parseEnvLines(previousContent);

  const changed: string[] = [];
  const added: string[] = [];
  for (const [key, entry] of globalEntries) {
    const prev = previousEntries.get(key);
    if (!prev) added.push(key);
    else if (prev.value !== entry.value && !SLOT_OWNED_KEYS.has(key)) changed.push(key);
  }

  const lines = globalContent.replace(/\s+$/, "").split("\n").map((line) => {
    const key = lineKey(line);
    const prev = key && SLOT_OWNED_KEYS.has(key) ? previousEntries.get(key) : undefined;
    return prev ? prev.raw : line;
  });

  const appended: string[] = [];
  const carried: string[] = [];
  for (const [key, entry] of previousEntries) {
    if (globalEntries.has(key)) continue;
    appended.push(entry.raw);
    if (!SLOT_OWNED_KEYS.has(key)) carried.push(key);
  }
  if (appended.length > 0) lines.push("", "# From the previous slot", ...appended);

  const body = lines.join("\n").replace(/^\n+/, "");
  return { content: body ? `${body}\n` : "", changed, added, carried };
}

interface EnvLine {
  raw: string;
  value: string;
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function lineKey(line: string): string | null {
  return line.match(ENV_LINE)?.[1] ?? null;
}

/** Key to raw line and normalized value. Last definition wins, as in compose. */
function parseEnvLines(content: string): Map<string, EnvLine> {
  const entries = new Map<string, EnvLine>();
  for (const raw of content.split("\n")) {
    if (raw.trimStart().startsWith("#")) continue;
    const match = raw.match(ENV_LINE);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    entries.set(match[1], { raw: raw.replace(/\r$/, ""), value });
  }
  return entries;
}

/** Copy the previous slot's `.env` into `target`. Returns the source path or null. */
async function copyPreviousSlotEnv(appDir: string, activeSlot: string | null, target: string): Promise<string | null> {
  const candidates = [
    join(appDir, "current", ".env"),
    ...(activeSlot ? [join(appDir, activeSlot, ".env")] : []),
    // Pre-migration layout, still live until the first engine deploy.
    join(appDir, "..", "env", "current", ".env"),
  ];

  for (const source of candidates) {
    try {
      await copyFile(source, target);
      return source;
    } catch (err) {
      if (!isAccessError(err)) continue;
      // The host `.env` is root-owned and mode 600; the app runs unprivileged.
      await copyAsRoot(source, target);
      return source;
    }
  }
  return null;
}

/** File contents, or null when missing or unreadable even as root. */
async function readEnvFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (!isAccessError(err)) return null;
  }
  try {
    return await readAsRoot(path);
  } catch {
    return null;
  }
}

function isAccessError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return (err as { code: string }).code === "EACCES" || (err as { code: string }).code === "EPERM";
}

/** Copy through a throwaway container, then hand the copy to the app's uid. */
async function copyAsRoot(source: string, target: string): Promise<void> {
  await execFileAsync(
    "docker",
    [
      "run", "--rm", "--log-driver", "none",
      "-v", `${await realDir(source)}:/from:ro`,
      "-v", `${dirname(target)}:/to`,
      "alpine", "sh", "-c",
      `cp /from/.env /to/.env && chown ${APP_UID}:${APP_UID} /to/.env && chmod 600 /to/.env`,
    ],
    { env: dockerEnv(), timeout: DOCKER_CLEANUP_TIMEOUT },
  );
}

/** Read a root-only file through a throwaway container. */
async function readAsRoot(path: string): Promise<string> {
  const real = await realpath(path);
  const { stdout } = await execFileAsync(
    "docker",
    ["run", "--rm", "--log-driver", "none", "-v", `${dirname(real)}:/from:ro`, "alpine", "cat", `/from/${basename(real)}`],
    { env: dockerEnv(), timeout: DOCKER_CLEANUP_TIMEOUT, encoding: "utf-8" },
  );
  return String(stdout);
}

/** Bind mounts follow symlinks on the host, so resolve before mounting. */
async function realDir(source: string): Promise<string> {
  return dirname(await realpath(source));
}
