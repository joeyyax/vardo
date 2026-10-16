// Build registry: built images are pushed here and reused from here by build key. Off when unset.

import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { execFileAsync } from "@/lib/utils/exec";
import type { RegistryCredential } from "./image-updates/registry";

export const BUILD_REGISTRY_SETTING = "build_registry";

/** Longest a single push or pull may run. */
export const REGISTRY_TRANSFER_TIMEOUT = 10 * 60_000;
const TAG_TIMEOUT = 30_000;

export type BuildRegistryConfig = { url: string; username: string; password: string };

export type BuildRegistry = {
  /** Registry host, with port when given. */
  host: string;
  /** Host plus namespace; image repos go under it. */
  prefix: string;
  credential: RegistryCredential | null;
};

const HOST = /^(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+|\[[0-9a-f:]+\])(?::\d{1,5})?$/;
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

/** `host[:port][/namespace...]` from a URL, or null when Docker couldn't use it as an image prefix. */
export function parseRegistryUrl(input: string): { host: string; prefix: string } | null {
  const trimmed = input.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const [rawHost, ...path] = trimmed.split("/");
  const host = rawHost.toLowerCase();
  if (!HOST.test(host)) return null;
  if (path.some((c) => !PATH_COMPONENT.test(c))) return null;
  return { host, prefix: [host, ...path].join("/") };
}

/** A name as a valid repo path component. */
export function repoComponent(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned || "app";
}

/** Registry ref for an image built with `key`: `<prefix>/<repo>:<key>`. */
export function registryRef(registry: Pick<BuildRegistry, "prefix">, repo: string, key: string): string {
  return `${registry.prefix}/${repoComponent(repo)}:${key}`;
}

/** Repo name for a compose service's image. */
export function serviceRepo(appName: string, service: string): string {
  return `${appName}-${service}`;
}

function parseStored(raw: string | null): BuildRegistryConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BuildRegistryConfig>;
    if (typeof parsed.url !== "string" || !parsed.url) return null;
    return { url: parsed.url, username: parsed.username ?? "", password: parsed.password ?? "" };
  } catch {
    return null;
  }
}

/** The stored config, decrypted. */
export async function getBuildRegistryConfig(): Promise<BuildRegistryConfig | null> {
  return parseStored(await getSystemSettingRaw(BUILD_REGISTRY_SETTING));
}

/** Saves the config encrypted; null turns the registry off. */
export async function setBuildRegistryConfig(config: BuildRegistryConfig | null): Promise<void> {
  await setSystemSetting(BUILD_REGISTRY_SETTING, config ? JSON.stringify(config) : "");
}

/** The configured registry, or null when none is set or its URL is unusable. */
export async function getBuildRegistry(): Promise<BuildRegistry | null> {
  const config = await getBuildRegistryConfig();
  const parsed = config ? parseRegistryUrl(config.url) : null;
  if (!config || !parsed) return null;
  return {
    ...parsed,
    credential: config.username && config.password ? { username: config.username, password: config.password } : null,
  };
}

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<unknown>;

export type RegistryOps = {
  ref: (repo: string, key: string) => string;
  /** Pulls `ref`; false when the registry doesn't have it or can't be reached. */
  pull: (ref: string) => Promise<boolean>;
  /** Tags `local` as `ref`, pushes it and drops the tag. Never throws. */
  push: (local: string, ref: string) => Promise<boolean>;
  /** Drops a local tag, leaving the image's other tags. */
  untag: (ref: string) => Promise<void>;
};

const NOT_FOUND = /manifest unknown|not found|does not exist|name unknown/i;

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr?.trim() || e?.message || String(err)).split("\n")[0];
}

/** Push and pull against `registry`, each under the configured logins. */
export function registryOps(
  registry: BuildRegistry,
  opts: {
    log: (line: string) => void;
    /** Runs a command with registry auth env. */
    withAuth: <T>(run: (env: NodeJS.ProcessEnv) => Promise<T>) => Promise<T>;
    exec?: Exec;
    signal?: AbortSignal;
  },
): RegistryOps {
  const exec = opts.exec ?? (execFileAsync as unknown as Exec);
  const run = (args: string[], env: NodeJS.ProcessEnv, timeout: number) =>
    exec("docker", args, { env, timeout, signal: opts.signal });

  const untag = async (ref: string) => {
    await opts.withAuth((env) => run(["image", "rm", ref], env, TAG_TIMEOUT)).catch(() => {});
  };

  return {
    ref: (repo, key) => registryRef(registry, repo, key),
    pull: async (ref) => {
      try {
        await opts.withAuth((env) => run(["pull", "--quiet", ref], env, REGISTRY_TRANSFER_TIMEOUT));
        return true;
      } catch (err) {
        const detail = firstLine(err);
        if (!NOT_FOUND.test(detail)) opts.log(`[registry] Couldn't pull ${ref}: ${detail}`);
        return false;
      }
    },
    push: async (local, ref) => {
      try {
        await opts.withAuth(async (env) => {
          await run(["tag", local, ref], env, TAG_TIMEOUT);
          try {
            await run(["push", "--quiet", ref], env, REGISTRY_TRANSFER_TIMEOUT);
          } finally {
            await run(["image", "rm", ref], env, TAG_TIMEOUT).catch(() => {});
          }
        });
        opts.log(`[registry] Pushed ${ref}`);
        return true;
      } catch (err) {
        opts.log(`[registry] Couldn't push ${ref}, keeping the local image: ${firstLine(err)}`);
        return false;
      }
    },
    untag,
  };
}
