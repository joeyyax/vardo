import { logger } from "@/lib/logger";
import { getSystemSettingRaw } from "@/lib/system-settings";
import type { ImageRef } from "./image-ref";

/**
 * Read-only registry access for update checks.
 *
 * Manifest requests count against Docker Hub's anonymous 100-per-6h pull
 * budget, so callers must go through `check.ts`, which caches and batches.
 * Nothing here pulls an image.
 */

/** List types first so the registry answers with the index digest, not a platform's. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TAG_PAGES = 5;
const USER_AGENT = "vardo-update-check";

export class RateLimitedError extends Error {
  constructor(
    readonly registry: string,
    readonly retryAfterMs: number | null,
  ) {
    super(`Registry ${registry} rate limited the request`);
    this.name = "RateLimitedError";
  }
}

export interface RegistryCredential {
  username: string;
  password: string;
}

type CredentialMap = Record<string, RegistryCredential>;

let credentialCache: { value: CredentialMap; at: number } | null = null;
const CREDENTIAL_TTL_MS = 60_000;

function credentialsFromEnv(): CredentialMap {
  const map: CredentialMap = {};
  const raw = process.env.VARDO_REGISTRY_CREDENTIALS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as CredentialMap;
      for (const [host, cred] of Object.entries(parsed)) {
        if (cred?.username && cred?.password) map[host] = cred;
      }
    } catch {
      logger.warn("VARDO_REGISTRY_CREDENTIALS is not valid JSON — ignoring");
    }
  }
  const user = process.env.DOCKERHUB_USERNAME;
  const token = process.env.DOCKERHUB_TOKEN ?? process.env.DOCKERHUB_PASSWORD;
  if (user && token) map["docker.io"] = { username: user, password: token };
  return map;
}

/** Env wins over stored settings so an operator can override without a write. */
export async function getRegistryCredentials(): Promise<CredentialMap> {
  if (credentialCache && Date.now() - credentialCache.at < CREDENTIAL_TTL_MS) {
    return credentialCache.value;
  }
  let stored: CredentialMap = {};
  try {
    const raw = await getSystemSettingRaw("registry_credentials");
    if (raw) stored = JSON.parse(raw) as CredentialMap;
  } catch {
    stored = {};
  }
  const value = { ...stored, ...credentialsFromEnv() };
  credentialCache = { value, at: Date.now() };
  return value;
}

export function invalidateRegistryCredentials() {
  credentialCache = null;
}

/** `docker.io` is the canonical name; the API lives on a different host. */
function apiHost(registry: string): string {
  return registry === "docker.io" ? "registry-1.docker.io" : registry;
}

function parseAuthenticate(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/([a-z_]+)="([^"]*)"/gi)) {
    params[match[1].toLowerCase()] = match[2];
  }
  return params;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, ...init.headers },
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchToken(
  challenge: Record<string, string>,
  credential: RegistryCredential | undefined,
): Promise<string | null> {
  const realm = challenge.realm;
  if (!realm) return null;
  const url = new URL(realm);
  if (challenge.service) url.searchParams.set("service", challenge.service);
  if (challenge.scope) url.searchParams.set("scope", challenge.scope);

  const headers: Record<string, string> = {};
  if (credential) {
    const basic = Buffer.from(`${credential.username}:${credential.password}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }

  const response = await timedFetch(url.toString(), { headers });
  if (!response.ok) return null;
  const body = (await response.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token ?? null;
}

/** Issues a request, answering a 401 auth challenge once. */
async function authedFetch(
  url: string,
  registry: string,
  init: RequestInit = {},
): Promise<Response> {
  const first = await timedFetch(url, init);
  if (first.status !== 401) return first;

  const challengeHeader = first.headers.get("www-authenticate");
  if (!challengeHeader?.toLowerCase().startsWith("bearer")) return first;

  const credentials = await getRegistryCredentials();
  const token = await fetchToken(parseAuthenticate(challengeHeader), credentials[registry]);
  if (!token) return first;

  return timedFetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
}

/**
 * Resolves a tag to its manifest digest via HEAD.
 *
 * Returns the manifest-list digest, which is what `docker inspect` reports
 * locally. Reading the first platform's digest instead reports false drift.
 */
export async function fetchRemoteDigest(ref: ImageRef, tag: string): Promise<string | null> {
  const url = `https://${apiHost(ref.registry)}/v2/${ref.repository}/manifests/${encodeURIComponent(tag)}`;
  const response = await authedFetch(url, ref.registry, {
    method: "HEAD",
    headers: { accept: MANIFEST_ACCEPT },
  });

  if (response.status === 429) throw new RateLimitedError(ref.registry, retryAfterMs(response));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Manifest HEAD failed with ${response.status}`);

  return response.headers.get("docker-content-digest");
}

/**
 * Docker Hub's repository API. Believed not to draw on the pull budget, unlike
 * `registry-1.docker.io`. Falls back to the registry API on any failure.
 */
async function fetchDockerHubTags(repository: string): Promise<string[]> {
  const tags: string[] = [];
  let url:
    | string
    | null = `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100&ordering=last_updated`;

  for (let page = 0; page < MAX_TAG_PAGES && url; page++) {
    const response = await timedFetch(url, { headers: { accept: "application/json" } });
    if (response.status === 429) throw new RateLimitedError("docker.io", retryAfterMs(response));
    if (!response.ok) throw new Error(`Hub tag list failed with ${response.status}`);
    const body = (await response.json()) as { results?: { name?: string }[]; next?: string | null };
    for (const result of body.results ?? []) {
      if (result.name) tags.push(result.name);
    }
    url = body.next ?? null;
  }
  return tags;
}

/** Enumerates tags. Paging stops at a bounded number of pages. */
export async function fetchTags(ref: ImageRef): Promise<string[]> {
  if (ref.registry === "docker.io") {
    try {
      return await fetchDockerHubTags(ref.repository);
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
      logger.warn(`Hub tag list failed for ${ref.repository}, trying the registry API`);
    }
  }

  const tags: string[] = [];
  let url: string | null =
    `https://${apiHost(ref.registry)}/v2/${ref.repository}/tags/list?n=100`;

  for (let page = 0; page < MAX_TAG_PAGES && url; page++) {
    const response: Response = await authedFetch(url, ref.registry, {
      headers: { accept: "application/json" },
    });
    if (response.status === 429) throw new RateLimitedError(ref.registry, retryAfterMs(response));
    if (!response.ok) throw new Error(`Tag list failed with ${response.status}`);

    const body = (await response.json()) as { tags?: string[] | null };
    for (const tag of body.tags ?? []) tags.push(tag);

    url = nextLink(response, apiHost(ref.registry));
  }
  return tags;
}

function nextLink(response: Response, host: string): string | null {
  const link = response.headers.get("link");
  const match = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  if (!match) return null;
  return match[1].startsWith("http") ? match[1] : `https://${host}${match[1]}`;
}
