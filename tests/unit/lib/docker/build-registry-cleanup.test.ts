import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ written: new Map<string, string>() }));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: async (key: string) => settings.written.get(key) ?? null,
  setSystemSetting: async (key: string, value: string) => void settings.written.set(key, value),
}));

import {
  CLEANUP_STATUS_SETTING,
  describeTag,
  ownedRepo,
  planRepoCleanup,
  registryBaseUrl,
  registryClient,
  runRegistryCleanup,
} from "@/lib/docker/build-registry-cleanup";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const ago = (hours: number) => NOW - hours * HOUR;

describe("planRepoCleanup", () => {
  const tag = (t: string, hoursAgo: number | null, digest = `sha256:${t}`) => ({ tag: t, digest, created: hoursAgo === null ? null : ago(hoursAgo) });

  it("keeps the newest three and deletes older ones past a day", () => {
    const tags = [tag("a", 100), tag("b", 90), tag("c", 80), tag("d", 70), tag("e", 60)];
    expect(planRepoCleanup(tags, { inUse: new Set(), now: NOW })).toEqual(["sha256:a", "sha256:b"]);
  });

  it("keeps tags younger than a day, tags in use here and tags of unknown age", () => {
    const tags = [tag("old", 200), tag("inuse", 190), tag("unknown", null), tag("n1", 10), tag("n2", 9), tag("n3", 8), tag("fresh", 30)];
    expect(planRepoCleanup(tags, { inUse: new Set(["inuse"]), now: NOW })).toEqual(["sha256:old", "sha256:fresh"]);
    const young = [tag("x", 100), tag("y", 90), tag("z", 80), tag("w", 2), tag("v", 23)];
    expect(planRepoCleanup(young, { inUse: new Set(), now: NOW, keep: 0 })).toEqual(["sha256:x", "sha256:y", "sha256:z"]);
  });

  it("keeps a digest when any tag on it is kept", () => {
    const tags = [tag("old", 100, "sha256:same"), tag("inuse", 99, "sha256:same"), tag("n1", 3), tag("n2", 2), tag("n3", 1)];
    expect(planRepoCleanup(tags, { inUse: new Set(["inuse"]), now: NOW, graceMs: 0 })).toEqual([]);
  });
});

describe("ownedRepo", () => {
  it("matches an app's repo and its services' repos only", () => {
    expect(ownedRepo("shop", ["shop"])).toBe(true);
    expect(ownedRepo("shop-web", ["shop"])).toBe(true);
    expect(ownedRepo("shopfront", ["shop"])).toBe(false);
    expect(ownedRepo("my-app", ["My App"])).toBe(true);
  });
});

describe("registryBaseUrl", () => {
  it("uses http for loopback or an http URL and https otherwise", () => {
    expect(registryBaseUrl("localhost:5001/vardo")).toBe("http://localhost:5001");
    expect(registryBaseUrl("http://registry.lan:5000")).toBe("http://registry.lan:5000");
    expect(registryBaseUrl("registry.example.com/jy0")).toBe("https://registry.example.com");
    expect(registryBaseUrl("https://localhost:5001")).toBe("https://localhost:5001");
    expect(registryBaseUrl("not a url")).toBeNull();
  });
});

type Image = { digest: string; created: number };

/** A registry:2 stand-in: catalog, tags, manifests, config blobs and deletes. */
function fakeRegistry(repos: Record<string, Record<string, Image>>, opts: { deletes?: boolean; bearer?: boolean } = {}) {
  const deleted: string[] = [];
  let tokenRequests = 0;
  const authHeaders: (string | null)[] = [];
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string>)?.authorization ?? null;
    authHeaders.push(auth);
    if (url.pathname === "/token") return (tokenRequests++, json({ token: "tok" }));
    if (opts.bearer && auth !== "Bearer tok") {
      return new Response("", { status: 401, headers: { "www-authenticate": `Bearer realm="https://auth.example.com/token",service="reg",scope="x"` } });
    }
    const path = url.pathname;
    if (path === "/v2/_catalog") return json({ repositories: Object.keys(repos).sort() });
    const m = path.match(/^\/v2\/(.+)\/(tags\/list|manifests|blobs)\/?(.*)$/);
    if (!m) return new Response("", { status: 404 });
    const [, name, kind, ref] = m;
    const repo = repos[name];
    if (!repo) return new Response("", { status: 404 });
    if (kind === "tags/list") return json({ name, tags: Object.keys(repo) });
    if (kind === "manifests" && method === "DELETE") {
      if (opts.deletes === false) return new Response(JSON.stringify({ errors: [{ code: "UNSUPPORTED" }] }), { status: 405 });
      const digest = decodeURIComponent(ref);
      for (const [t, img] of Object.entries(repo)) if (img.digest === digest) delete repo[t];
      deleted.push(`${name}@${digest}`);
      return new Response("", { status: 202 });
    }
    if (kind === "manifests") {
      const img = Object.values(repo).find((i) => i.digest === ref) ?? repo[decodeURIComponent(ref)];
      if (!img) return new Response("", { status: 404 });
      return json({ schemaVersion: 2, config: { digest: `cfg-${img.digest}` } }, { "docker-content-digest": img.digest });
    }
    const img = Object.values(repo).find((i) => `cfg-${i.digest}` === ref);
    return img ? json({ created: new Date(img.created).toISOString() }) : new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, deleted, authHeaders, repos, tokenRequests: () => tokenRequests };
}

function images(prefix: string, hoursAgo: number[]): Record<string, Image> {
  return Object.fromEntries(hoursAgo.map((h, i) => [`${prefix}${i}`, { digest: `sha256:${prefix}${i}`, created: ago(h) }]));
}

describe("runRegistryCleanup", () => {
  beforeEach(() => settings.written.clear());
  const config = { url: "localhost:5001/vardo", username: "u", password: "p" };

  it("deletes old tags in this instance's repos under the namespace and leaves everything else", async () => {
    const reg = fakeRegistry({
      "vardo/shop": images("s", [100, 90, 80, 70, 60]),
      "vardo/shop-web": images("w", [100, 50, 40, 30]),
      "vardo/elsewhere": images("e", [100, 90, 80, 70]),
      "other/shop": images("o", [100, 90, 80, 70]),
    });
    const result = await runRegistryCleanup({ config, fetch: reg.fetchImpl, now: NOW, state: { appNames: ["shop"], inUse: new Set(["s1"]) } });

    expect(reg.deleted.sort()).toEqual(["vardo/shop-web@sha256:w0", "vardo/shop@sha256:s0"]);
    expect(Object.keys(reg.repos["vardo/shop"]).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(Object.keys(reg.repos["vardo/elsewhere"])).toHaveLength(4);
    expect(Object.keys(reg.repos["other/shop"])).toHaveLength(4);
    expect(result).toMatchObject({ deleted: 2, kept: 7 });
    expect(reg.authHeaders.every((h) => h === `Basic ${Buffer.from("u:p").toString("base64")}`)).toBe(true);
    expect(JSON.parse(settings.written.get(CLEANUP_STATUS_SETTING)!)).toMatchObject({ deleted: 2, kept: 7 });
  });

  it("records that the registry refuses deletes", async () => {
    const reg = fakeRegistry({ "vardo/shop": images("s", [100, 90, 80, 70]) }, { deletes: false });
    const result = await runRegistryCleanup({ config, fetch: reg.fetchImpl, now: NOW, state: { appNames: ["shop"], inUse: new Set() } });
    expect(result?.deleted).toBe(0);
    expect(result?.error).toContain("REGISTRY_STORAGE_DELETE_ENABLED=true");
    expect(JSON.parse(settings.written.get(CLEANUP_STATUS_SETTING)!).error).toContain("refuses deletes");
  });

  it("does nothing without a registry", async () => {
    expect(await runRegistryCleanup({ config: null })).toBeNull();
    expect(settings.written.size).toBe(0);
  });
});

describe("registryClient", () => {
  it("answers a bearer challenge with a token fetched under basic auth, once per scope", async () => {
    const reg = fakeRegistry({ "a": images("a", [1]) }, { bearer: true });
    const client = registryClient("https://reg.example.com", { username: "u", password: "p" }, reg.fetchImpl);
    expect((await client.request("GET", "/v2/a/tags/list")).status).toBe(200);
    expect((await client.request("GET", "/v2/a/tags/list")).status).toBe(200);
    expect(reg.tokenRequests()).toBe(1);
    expect(reg.authHeaders.filter((h) => h === "Bearer tok")).toHaveLength(2);
  });
});

describe("describeTag", () => {
  it("reads an index's image manifest past its attestation for the build time, under the index digest", async () => {
    const bodies: Record<string, unknown> = {
      "/v2/a/manifests/k1": { manifests: [{ digest: "sha256:att", platform: { os: "unknown" } }, { digest: "sha256:img", platform: { os: "linux" } }] },
      "/v2/a/manifests/sha256:img": { config: { digest: "sha256:cfg" } },
      "/v2/a/blobs/sha256:cfg": { created: "2026-10-15T12:00:00Z" },
    };
    const fetchImpl = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      return path in bodies
        ? new Response(JSON.stringify(bodies[path]), { headers: { "docker-content-digest": "sha256:index" } })
        : new Response("", { status: 404 });
    }) as typeof fetch;
    const client = registryClient("http://localhost:5001", null, fetchImpl);
    expect(await describeTag(client, "a", "k1")).toEqual({ digest: "sha256:index", created: ago(24) });
  });
});
