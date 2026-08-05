// ---------------------------------------------------------------------------
// Registry authentication for image pulls.
//
// Vardo's own container holds no Docker credentials, so `docker compose pull`
// authenticates as nobody. The configured credentials are handed to the pull
// through a throwaway DOCKER_CONFIG directory: never on argv, which `ps` shows
// to every user on the host, and never in the shared ~/.docker/config.json,
// which concurrent deploys would race over.
// ---------------------------------------------------------------------------

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { parseImageRef } from "./image-updates/image-ref";
import { getRegistryCredentials, type RegistryCredential } from "./image-updates/registry";

/** Docker Hub's auth entry is keyed by the v1 endpoint, not by the registry host. */
const DOCKER_HUB_KEY = "https://index.docker.io/v1/";

/** What Docker prints when it pulled without usable credentials. */
const AUTH_FAILURE =
  /unauthorized|authentication required|no basic auth credentials|pull access denied|requested access to the resource is denied/i;

type AuthEntry = { auth?: string; [key: string]: unknown };

function authKey(host: string): string {
  return host === "docker.io" || host === "index.docker.io" ? DOCKER_HUB_KEY : host;
}

/** Where the Docker CLI reads its config when nothing overrides it. */
function baseConfigDir(): string {
  return process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");
}

/** Auth entries already on disk, so a config an operator mounted keeps working. */
async function mountedAuths(): Promise<Record<string, AuthEntry>> {
  try {
    const parsed = JSON.parse(await readFile(join(baseConfigDir(), "config.json"), "utf-8")) as {
      auths?: Record<string, AuthEntry>;
    };
    return parsed.auths ?? {};
  } catch {
    return {};
  }
}

/** Renders credentials as a Docker CLI config. Configured ones win over mounted ones. */
export function buildDockerConfig(
  credentials: Record<string, RegistryCredential>,
  mounted: Record<string, AuthEntry> = {},
): string {
  const auths: Record<string, AuthEntry> = { ...mounted };
  for (const [host, cred] of Object.entries(credentials)) {
    auths[authKey(host)] = {
      auth: Buffer.from(`${cred.username}:${cred.password}`).toString("base64"),
    };
  }
  return JSON.stringify({ auths });
}

/**
 * Runs `run` against a Docker config carrying the configured registry logins,
 * removed once it returns. Hands the ambient environment straight through when
 * no credentials are configured.
 */
export async function withRegistryAuth<T>(
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const credentials = await getRegistryCredentials();
  if (Object.keys(credentials).length === 0) return run(process.env);

  const dir = await mkdtemp(join(tmpdir(), "vardo-docker-config-"));
  try {
    const config = buildDockerConfig(credentials, await mountedAuths());
    await writeFile(join(dir, "config.json"), config, { mode: 0o600 });
    return await run({ ...process.env, DOCKER_CONFIG: dir });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Names the registries a failed pull had no credentials for. Null when the
 * failure was not an authentication one, or every registry involved is covered.
 */
export async function registryAuthHint(
  message: string,
  images: (string | undefined)[],
): Promise<string | null> {
  if (!AUTH_FAILURE.test(message)) return null;

  const configured = new Set(Object.keys(await getRegistryCredentials()));
  const missing = new Set<string>();
  for (const image of images) {
    const ref = image ? parseImageRef(image) : null;
    if (ref && !configured.has(ref.registry)) missing.add(ref.registry);
  }
  if (missing.size === 0) return null;

  return `No registry credentials are configured for ${[...missing].sort().join(", ")} — set VARDO_REGISTRY_CREDENTIALS so the pull can authenticate.`;
}
