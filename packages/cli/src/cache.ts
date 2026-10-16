import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Instance } from "./config";
import type { Tool } from "./schema";

export const TOOLS_TTL_MS = 5 * 60 * 1000;

type Env = Record<string, string | undefined>;

/** One file per URL and token, since tokens see different tools. */
export function toolsCachePath(env: Env, target: Instance): string {
  const key = createHash("sha256").update(`${target.url}\0${target.token}`).digest("hex").slice(0, 16);
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "vardo", `tools-${key}.json`);
}

export function readToolsCache(path: string, now: number): Tool[] | null {
  try {
    const { at, tools } = JSON.parse(readFileSync(path, "utf8")) as { at: number; tools: Tool[] };
    return now - at < TOOLS_TTL_MS && Array.isArray(tools) ? tools : null;
  } catch {
    return null;
  }
}

export function writeToolsCache(path: string, tools: Tool[], now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ at: now, tools }), { mode: 0o600 });
  } catch {}
}
