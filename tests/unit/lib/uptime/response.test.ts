import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NO_ROUTE_HEADER,
  NO_ROUTE_VALUE,
  SIZE_READ_BYTES,
  cacheOf,
  hashBody,
  imageHealthPaths,
  imageRepo,
  qualifiesAsHealth,
  qualifiesAsImageHealth,
  runHttpCheck,
  type HttpCheck,
  type Sample,
} from "@/lib/uptime/core";

const h = (headers: Record<string, string>) => new Headers(headers);

describe("cacheOf", () => {
  it.each([
    [{ "cf-cache-status": "HIT" }, "cloudflare"],
    [{ "cf-cache-status": "stale" }, "cloudflare"],
    [{ "cf-cache-status": "REVALIDATED" }, "cloudflare"],
    [{ "cf-cache-status": "UPDATING" }, "cloudflare"],
    [{ "x-vercel-cache": "HIT" }, "vercel"],
    [{ "x-vercel-cache": "PRERENDER" }, "vercel"],
    [{ "x-cache": "Hit from cloudfront" }, "cloudfront"],
    [{ "x-cache": "RefreshHit from cloudfront" }, "cloudfront"],
    [{ "x-cache": "MISS, HIT", "x-served-by": "cache-a, cache-b" }, "fastly"],
    [{ "x-cache": "HIT" }, "cache"],
    [{ "x-cache-status": "HIT" }, "proxy"],
    [{ age: "120" }, "cache"],
  ])("reads %j as %s", (headers, cache) => expect(cacheOf(h(headers))).toBe(cache));

  it.each([
    [{}],
    [{ "cf-cache-status": "DYNAMIC", age: "40" }],
    [{ "cf-cache-status": "BYPASS" }],
    [{ "cf-cache-status": "MISS" }],
    [{ "cf-cache-status": "EXPIRED" }],
    [{ "x-vercel-cache": "MISS" }],
    [{ "x-cache": "Miss from cloudfront" }],
    [{ "x-cache": "HIT, MISS", "x-served-by": "a, b" }],
    [{ "x-cache-status": "BYPASS" }],
    [{ "x-nextjs-cache": "HIT" }],
    [{ age: "0" }],
  ])("reads %j as the origin", (headers) => expect(cacheOf(h(headers))).toBeNull());
});

describe("image health paths", () => {
  it.each([
    ["ghcr.io/goauthentik/server:2025.2", "goauthentik/server"],
    ["registry:2", "registry"],
    ["docker.io/library/registry:2.8@sha256:abc", "registry"],
    ["lscr.io/linuxserver/transmission:latest", "linuxserver/transmission"],
    ["localhost:5000/ollama/ollama", "ollama/ollama"],
    ["gitea/gitea", "gitea/gitea"],
  ])("takes the repository of %s", (image, repo) => expect(imageRepo(image)).toBe(repo));

  it("finds known paths in the given order and skips unknown images", () => {
    expect(imageHealthPaths(["postgres:17", "ghcr.io/immich-app/immich-server:v1.120", null, "registry:2"])).toEqual([
      { path: "/api/server/ping", status: [200] },
      { path: "/v2/", status: [200, 401] },
    ]);
    expect(imageHealthPaths(["nginx", "someone/server"])).toEqual([]);
  });

  const sample = (s: Partial<Sample>): Sample => ({ status: 200, contentType: "text/html", bytes: 10, hash: hashBody("x"), ...s });
  const home = sample({ hash: hashBody("home") });

  it("takes a registry's 401 at /v2/ but not the homepage served there or the catch-all", () => {
    expect(qualifiesAsImageHealth(sample({ status: 401, contentType: "application/json" }), home, [200, 401])).toBe(true);
    expect(qualifiesAsImageHealth(sample({ status: 404 }), home, [200, 401])).toBe(false);
    expect(qualifiesAsImageHealth({ ...home }, home, [200])).toBe(false);
    expect(qualifiesAsImageHealth(sample({ noRoute: true }), home, [200])).toBe(false);
    expect(qualifiesAsHealth(sample({ noRoute: true, contentType: "text/plain" }), home)).toBe(false);
  });
});

describe("runHttpCheck", () => {
  const check: HttpCheck = { type: "http", url: "https://ingest.example.com/drain", expectedStatus: { min: 100, max: 499 }, timeoutMs: 1000 };
  const ctx = { monitorId: "m", vantageId: "local", path: "local" as const };
  const run = (c: HttpCheck, res: () => Response, seen: RequestInit[] = []) =>
    runHttpCheck(c, { ...ctx, fetch: (async (_url: string, init: RequestInit) => (seen.push(init), res())) as unknown as typeof fetch });

  it("reads Vardo's catch-all as no route even though 404 is in range", async () => {
    const res = await run(check, () => new Response("nothing", { status: 404, headers: { [NO_ROUTE_HEADER]: NO_ROUTE_VALUE } }));
    expect(res).toMatchObject({ ok: false, status: 404, error: "no-route" });
    expect((await run(check, () => new Response("app 404", { status: 404 }))).ok).toBe(true);
  });

  it("sends the check's method, GET by default", async () => {
    const seen: RequestInit[] = [];
    await run({ ...check, method: "POST", expectedStatus: { min: 401, max: 401 } }, () => new Response(null, { status: 401 }), seen);
    await run(check, () => new Response(null), seen);
    expect(seen.map((s) => s.method)).toEqual(["POST", "GET"]);
  });

  it("records the cache that answered and the body size", async () => {
    const res = await run(check, () => new Response("x".repeat(3000), { headers: { "cf-cache-status": "HIT" } }));
    expect(res).toMatchObject({ ok: true, cache: "cloudflare", bytes: 3000 });
    const origin = await run(check, () => new Response("ok", { headers: { "cf-cache-status": "DYNAMIC" } }));
    expect(origin.cache).toBeUndefined();
  });

  it("stops reading a large body without a length at the cap, and trusts Content-Length when sent", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 16_384;
        c.enqueue(new Uint8Array(16_384));
        if (pulled > 10_000_000) c.close();
      },
    });
    const res = await run(check, () => new Response(stream));
    expect(res.bytes).toBe(SIZE_READ_BYTES);
    expect(pulled).toBeLessThan(SIZE_READ_BYTES * 3);
    const declared = await run(check, () => new Response("abc", { headers: { "content-length": "3" } }));
    expect(declared.bytes).toBe(3);
  });
});

describe("the no-route marker", () => {
  it("is what next.config.ts sets on /unknown-host, the page Traefik sends unknown hosts to", () => {
    const config = readFileSync("next.config.ts", "utf8");
    const block = config.slice(config.indexOf('source: "/unknown-host"'));
    expect(block).toMatch(new RegExp(`key: "${NO_ROUTE_HEADER}", value: "${NO_ROUTE_VALUE}"`));
    const compose = readFileSync("docker-compose.yml", "utf8");
    expect(compose).toContain("replacepathregex.replacement=/unknown-host");
  });
});
