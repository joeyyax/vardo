// Deletes build registry tags nothing here needs, through the registry HTTP API.
// Deleting a manifest frees no disk until the registry runs `registry garbage-collect`.

import { logger } from "@/lib/logger";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { BUILD_KEY_LABEL } from "./build-key";
import { getBuildRegistryConfig, parseRegistryUrl, repoComponent } from "./build-registry";
import { ROLLBACK_IMAGES_RETAINED } from "./constants";
import type { RegistryCredential } from "./image-updates/registry";

const log = logger.child("build-registry");

/** Newest tags kept per repo, matching the rollback images each app keeps here. */
export const REGISTRY_KEEP_PER_REPO = ROLLBACK_IMAGES_RETAINED;
/** Tags younger than this are kept, so a build between push and pull keeps its image. */
export const REGISTRY_GRACE_MS = 24 * 60 * 60_000;
export const CLEANUP_STATUS_SETTING = "build_registry_cleanup";

const CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;
const STARTUP_DELAY_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 50;

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

type Fetch = typeof fetch;

export class DeletesDisabledError extends Error {
  constructor() {
    super("The registry refuses deletes. Set REGISTRY_STORAGE_DELETE_ENABLED=true on it.");
  }
}

/** Base URL for the registry API: http for a scheme given as http or a loopback host, else https. */
export function registryBaseUrl(url: string): string | null {
  const parsed = parseRegistryUrl(url);
  if (!parsed) return null;
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(parsed.host);
  const http = /^http:\/\//i.test(url.trim()) || (loopback && !/^https:\/\//i.test(url.trim()));
  return `${http ? "http" : "https"}://${parsed.host}`;
}

function challengeParams(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/([a-z_]+)="([^"]*)"/gi)) params[m[1].toLowerCase()] = m[2];
  return params;
}

export type RegistryClient = { request: (method: string, path: string, accept?: string) => Promise<Response> };

/** Registry API requests with basic auth, answering a bearer challenge once. */
export function registryClient(baseUrl: string, credential: RegistryCredential | null, fetchImpl: Fetch = fetch): RegistryClient {
  const basic = credential ? `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}` : null;
  const tokens = new Map<string, string>();
  const send = (method: string, url: string, accept: string | undefined, auth: string | null) =>
    fetchImpl(url, {
      method,
      headers: { ...(accept ? { accept } : {}), ...(auth ? { authorization: auth } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });

  return {
    request: async (method, path, accept) => {
      const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
      const first = await send(method, url, accept, basic);
      const challenge = first.headers.get("www-authenticate");
      if (first.status !== 401 || !challenge?.toLowerCase().startsWith("bearer")) return first;
      const params = challengeParams(challenge);
      if (!params.realm || (!/^https:\/\//i.test(params.realm) && !params.realm.startsWith(baseUrl))) return first;
      const key = `${params.service ?? ""} ${params.scope ?? ""}`;
      let token = tokens.get(key);
      if (!token) {
        const realm = new URL(params.realm);
        if (params.service) realm.searchParams.set("service", params.service);
        if (params.scope) realm.searchParams.set("scope", params.scope);
        const res = await send("GET", realm.toString(), "application/json", basic);
        if (!res.ok) return first;
        const body = (await res.json()) as { token?: string; access_token?: string };
        token = body.token ?? body.access_token;
        if (!token) return first;
        tokens.set(key, token);
      }
      return send(method, url, accept, `Bearer ${token}`);
    },
  };
}

function nextPage(res: Response): string | null {
  const m = res.headers.get("link")?.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  return m ? m[1] : null;
}

async function paged<T>(client: RegistryClient, first: string, read: (body: T) => string[]): Promise<{ items: string[]; status: number }> {
  const items: string[] = [];
  let path: string | null = first;
  for (let page = 0; page < MAX_PAGES && path; page++) {
    const res = await client.request("GET", path, "application/json");
    if (!res.ok) return { items, status: res.status };
    items.push(...read((await res.json()) as T));
    path = nextPage(res);
  }
  return { items, status: 200 };
}

/** Every repo in the registry under `namespace`, without it. */
export async function listRepositories(client: RegistryClient, namespace: string): Promise<string[]> {
  const { items, status } = await paged<{ repositories?: string[] }>(client, "/v2/_catalog?n=1000", (b) => b.repositories ?? []);
  if (status !== 200) throw new Error(`The registry didn't list its repositories (HTTP ${status}), so nothing was cleaned up.`);
  const prefix = namespace ? `${namespace}/` : "";
  return items.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length)).filter((r) => !r.includes("/"));
}

export async function listTags(client: RegistryClient, name: string): Promise<string[]> {
  const { items, status } = await paged<{ tags?: string[] | null }>(client, `/v2/${name}/tags/list?n=1000`, (b) => b.tags ?? []);
  if (status === 404) return [];
  if (status !== 200) throw new Error(`Couldn't list tags for ${name} (HTTP ${status})`);
  return items;
}

type Manifest = { config?: { digest?: string }; manifests?: { digest: string; platform?: { os?: string } }[] };

/** A tag's manifest digest and its image's build time, null when unreadable. */
export async function describeTag(client: RegistryClient, name: string, tag: string): Promise<{ digest: string; created: number | null } | null> {
  const res = await client.request("GET", `/v2/${name}/manifests/${encodeURIComponent(tag)}`, MANIFEST_ACCEPT);
  if (!res.ok) return null;
  const digest = res.headers.get("docker-content-digest");
  if (!digest) return null;
  let manifest = (await res.json()) as Manifest;
  // An index's attestations have platform os "unknown".
  const image = manifest.manifests?.find((m) => m.platform?.os !== "unknown");
  if (image) {
    const inner = await client.request("GET", `/v2/${name}/manifests/${image.digest}`, MANIFEST_ACCEPT);
    manifest = inner.ok ? ((await inner.json()) as Manifest) : {};
  }
  const config = manifest.config?.digest;
  if (!config) return { digest, created: null };
  const blob = await client.request("GET", `/v2/${name}/blobs/${config}`);
  if (!blob.ok) return { digest, created: null };
  const created = Date.parse(((await blob.json()) as { created?: string }).created ?? "");
  return { digest, created: Number.isFinite(created) ? created : null };
}

/** Deletes a manifest by digest, which drops every tag on it. */
export async function deleteManifest(client: RegistryClient, name: string, digest: string): Promise<void> {
  const res = await client.request("DELETE", `/v2/${name}/manifests/${digest}`);
  if (res.status === 405) throw new DeletesDisabledError();
  if (!res.ok && res.status !== 404) throw new Error(`Couldn't delete ${name}@${digest} (HTTP ${res.status})`);
}

/** True when `repo` is one this instance's apps push to: `<app>` or `<app>-<service>`. */
export function ownedRepo(repo: string, appNames: string[]): boolean {
  return appNames.some((name) => {
    const own = repoComponent(name);
    return repo === own || repo.startsWith(`${own}-`);
  });
}

export type TagInfo = { tag: string; digest: string; created: number | null };

/**
 * Digests to delete from one repo. Kept: the newest `keep` tags, tags whose build key an image here carries,
 * tags younger than `graceMs` and tags of unknown age. A digest goes only when none of its tags is kept.
 */
export function planRepoCleanup(
  tags: TagInfo[],
  opts: { inUse: Set<string>; now: number; keep?: number; graceMs?: number },
): string[] {
  const keep = opts.keep ?? REGISTRY_KEEP_PER_REPO;
  const grace = opts.graceMs ?? REGISTRY_GRACE_MS;
  const newest = [...tags].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const kept = new Set<string>();
  newest.forEach((t, i) => {
    if (i < keep || t.created === null || opts.now - t.created < grace || opts.inUse.has(t.tag)) kept.add(t.digest);
  });
  return [...new Set(tags.map((t) => t.digest))].filter((d) => !kept.has(d));
}

export type CleanupStatus = { at: string; deleted: number; kept: number; error?: string };

export async function getCleanupStatus(): Promise<CleanupStatus | null> {
  try {
    const raw = await getSystemSettingRaw(CLEANUP_STATUS_SETTING);
    return raw ? (JSON.parse(raw) as CleanupStatus) : null;
  } catch {
    return null;
  }
}

/** App names here, and build keys on images here. */
async function localState(): Promise<{ appNames: string[]; inUse: Set<string> }> {
  const [{ db }, { apps }, { listImages }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/db/schema"),
    import("./client"),
  ]);
  const rows = await db.select({ name: apps.name }).from(apps);
  const images = await listImages({ label: [BUILD_KEY_LABEL] });
  return {
    appNames: rows.map((r) => r.name),
    inUse: new Set(images.map((i) => i.labels[BUILD_KEY_LABEL]).filter(Boolean)),
  };
}

export type CleanupDeps = {
  config?: { url: string; username: string; password: string } | null;
  state?: { appNames: string[]; inUse: Set<string> };
  fetch?: Fetch;
  now?: number;
};

/** One cleanup pass. Null when no registry is set. */
export async function runRegistryCleanup(deps: CleanupDeps = {}): Promise<(CleanupStatus & { removed: string[] }) | null> {
  const config = deps.config === undefined ? await getBuildRegistryConfig() : deps.config;
  const parsed = config ? parseRegistryUrl(config.url) : null;
  const baseUrl = config ? registryBaseUrl(config.url) : null;
  if (!config || !parsed || !baseUrl) return null;

  const now = deps.now ?? Date.now();
  const credential = config.username && config.password ? { username: config.username, password: config.password } : null;
  const client = registryClient(baseUrl, credential, deps.fetch);
  const namespace = parsed.prefix.slice(parsed.host.length + 1);
  const removed: string[] = [];
  let kept = 0;
  let error: string | undefined;
  try {
    const { appNames, inUse } = deps.state ?? (await localState());
    for (const repo of await listRepositories(client, namespace)) {
      if (!ownedRepo(repo, appNames)) continue;
      const name = namespace ? `${namespace}/${repo}` : repo;
      const tagNames = await listTags(client, name);
      if (tagNames.length <= REGISTRY_KEEP_PER_REPO) {
        kept += tagNames.length;
        continue;
      }
      const tags: TagInfo[] = [];
      for (const tag of tagNames) {
        const info = await describeTag(client, name, tag);
        if (info) tags.push({ tag, ...info });
        else kept++;
      }
      const doomed = new Set(planRepoCleanup(tags, { inUse, now }));
      kept += tags.filter((t) => !doomed.has(t.digest)).length;
      for (const digest of doomed) {
        await deleteManifest(client, name, digest);
        removed.push(...tags.filter((t) => t.digest === digest).map((t) => `${name}:${t.tag}`));
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const status: CleanupStatus = { at: new Date(now).toISOString(), deleted: removed.length, kept, ...(error ? { error } : {}) };
  await setSystemSetting(CLEANUP_STATUS_SETTING, JSON.stringify(status)).catch(() => {});
  return { ...status, removed };
}

export const buildRegistryCleanupLoop = new IntervalLoop({
  name: "build-registry-cleanup",
  intervalMs: CLEANUP_INTERVAL_MS,
  firstRunMs: STARTUP_DELAY_MS,
  log,
  run: async () => {
    const result = await runRegistryCleanup();
    if (!result) return;
    if (result.error) log.warn(`Cleanup stopped after ${result.deleted} tag(s): ${result.error}`);
    else if (result.deleted > 0) log.info(`Deleted ${result.deleted} old tag(s), kept ${result.kept}`);
  },
});
