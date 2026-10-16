import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "./args";

export type Instance = { url: string; token: string };

export type Config = { default?: string; instances: Record<string, Instance> };

export type Target = Instance & { name: string };

type Env = Record<string, string | undefined>;

export function configPath(env: Env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vardo", "config.json");
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { instances: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<Config>;
    return { default: parsed.default, instances: parsed.instances ?? {} };
  } catch {
    throw new UsageError(`${path} isn't valid JSON. Fix it or delete it and log in again.`);
  }
}

/** Writes the config readable by its owner only. */
export function saveConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** `vardo.example.com/` or `https://vardo.example.com/api/mcp` → `https://vardo.example.com`. */
export function normalizeUrl(input: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`"${input}" isn't a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError(`"${input}" isn't an http or https URL.`);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/mcp$/, "");
  return `${url.origin}${path}`;
}

/** The name an instance is saved under: its host. */
export function instanceName(url: string): string {
  return new URL(url).host;
}

/** Picks the instance: `--use`, then VARDO_URL and VARDO_TOKEN, then the default. */
export function resolveTarget(config: Config, env: Env, use?: string): Target {
  if (use) {
    const found = config.instances[use];
    if (!found) throw new UsageError(`No saved instance named ${use}. Run \`vardo instances\`.`);
    return { name: use, ...found };
  }

  const envToken = env.VARDO_TOKEN?.trim() || undefined;
  if (env.VARDO_URL) {
    const url = normalizeUrl(env.VARDO_URL);
    const saved = Object.entries(config.instances).find(([, i]) => i.url === url);
    const token = envToken ?? saved?.[1].token;
    if (!token) throw new UsageError(`Set VARDO_TOKEN or run \`vardo login ${url}\`.`);
    return { name: saved?.[0] ?? instanceName(url), url, token };
  }

  const name = config.default;
  const saved = name ? config.instances[name] : undefined;
  if (envToken) {
    if (!name || !saved) throw new UsageError("VARDO_TOKEN is set but VARDO_URL isn't.");
    return { name, url: saved.url, token: envToken };
  }
  if (!name || !saved) throw new UsageError("Not logged in. Run `vardo login <url>`.");
  return { name, ...saved };
}
