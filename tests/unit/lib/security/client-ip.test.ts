// A request straight to the console can't choose its own rate-limit key with X-Forwarded-For (#889).

import { spawn, type ChildProcess } from "child_process";
import { request } from "http";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dockerRequestMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/docker/client", () => ({ dockerRequest: dockerRequestMock }));

const { resolveClientIp, clientIpFor, PEER_HEADER } = await import("@/lib/security/client-ip");
const { cidrMatcher } = await import("@/lib/cloudflare-ips");
const { BUNDLED_RANGES } = await import("@/lib/docker/cloudflare-only");
const { proxy } = await import("@/proxy");

const TRAEFIK = "172.18.0.2";
const APP = "172.18.0.9";

beforeEach(() => {
  dockerRequestMock.mockResolvedValue({ NetworkSettings: { Networks: { "vardo-network": { IPAddress: TRAEFIK } } } });
});

const isTraefik = (ip: string) => ip === TRAEFIK;
const h = (init: Record<string, string>) => new Headers(init);

describe("resolveClientIp", () => {
  it("keys a direct request by its peer, ignoring a forged X-Forwarded-For", () => {
    expect(resolveClientIp(h({ [PEER_HEADER]: APP, "x-forwarded-for": "6.6.6.6" }), isTraefik)).toBe(APP);
  });

  it("trusts X-Forwarded-For from Traefik", () => {
    expect(resolveClientIp(h({ [PEER_HEADER]: TRAEFIK, "x-forwarded-for": "203.0.113.7" }), isTraefik)).toBe("203.0.113.7");
  });

  it("reads an IPv4-mapped peer as IPv4", () => {
    expect(resolveClientIp(h({ [PEER_HEADER]: `::ffff:${TRAEFIK}`, "x-real-ip": "203.0.113.7" }), isTraefik)).toBe("203.0.113.7");
  });

  it("falls back to the forwarded headers without a peer header", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "203.0.113.7" }), isTraefik)).toBe("203.0.113.7");
  });
});

describe("resolveClientIp behind Cloudflare (#902)", () => {
  const isCloudflare = cidrMatcher([...BUNDLED_RANGES.v4, ...BUNDLED_RANGES.v6]);
  const CF_EDGE = "172.70.1.2";
  const CF_EDGE_V6 = "2606:4700:10::ac43:1";
  const resolve = (init: Record<string, string>) => resolveClientIp(h({ [PEER_HEADER]: TRAEFIK, ...init }), isTraefik, isCloudflare);

  it("reads CF-Connecting-IP when Traefik's peer was a Cloudflare edge", () => {
    expect(resolve({ "x-forwarded-for": `203.0.113.7, ${CF_EDGE}`, "cf-connecting-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("ignores a forged X-Forwarded-For that Cloudflare passed through", () => {
    expect(resolve({ "x-forwarded-for": `6.6.6.6, 203.0.113.7, ${CF_EDGE}`, "x-real-ip": "6.6.6.6", "cf-connecting-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("ignores CF-Connecting-IP from a client that skipped Cloudflare", () => {
    expect(resolve({ "x-forwarded-for": "198.51.100.4", "cf-connecting-ip": "6.6.6.6" })).toBe("198.51.100.4");
  });

  it("ignores a forged chain ending in a Cloudflare address when Traefik's peer wasn't one", () => {
    expect(resolve({ "x-forwarded-for": `${CF_EDGE}, 198.51.100.4`, "cf-connecting-ip": "6.6.6.6" })).toBe("198.51.100.4");
  });

  it("ignores CF-Connecting-IP from an app on the network", () => {
    const headers = h({ [PEER_HEADER]: APP, "x-forwarded-for": CF_EDGE, "cf-connecting-ip": "6.6.6.6" });
    expect(resolveClientIp(headers, isTraefik, isCloudflare)).toBe(APP);
  });

  it("never reads CF-Connecting-IP without a peer header", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": CF_EDGE, "cf-connecting-ip": "6.6.6.6" }), isTraefik, isCloudflare)).toBe(CF_EDGE);
  });

  it("keys by the edge when Cloudflare's header is missing or not an address", () => {
    expect(resolve({ "x-forwarded-for": CF_EDGE })).toBe(CF_EDGE);
    expect(resolve({ "x-forwarded-for": CF_EDGE, "cf-connecting-ip": "<script>" })).toBe(CF_EDGE);
  });

  it("keys a direct client by its own address without Cloudflare", () => {
    expect(resolve({ "x-forwarded-for": "198.51.100.4" })).toBe("198.51.100.4");
  });

  it("handles IPv6 edges and clients", () => {
    expect(resolve({ "x-forwarded-for": CF_EDGE_V6, "cf-connecting-ip": "2001:db8::7" })).toBe("2001:db8::7");
    expect(resolve({ "x-forwarded-for": CF_EDGE, "cf-connecting-ip": "2001:db8::7" })).toBe("2001:db8::7");
    expect(resolve({ "x-forwarded-for": "2001:db8::9", "cf-connecting-ip": "6.6.6.6" })).toBe("2001:db8::9");
  });

  it("reads an IPv4-mapped edge as IPv4", () => {
    expect(resolve({ "x-forwarded-for": `::ffff:${CF_EDGE}`, "cf-connecting-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });
});

describe("clientIpFor", () => {
  const viaCloudflare = h({ [PEER_HEADER]: TRAEFIK, "x-forwarded-for": "6.6.6.6, 172.70.1.2", "cf-connecting-ip": "203.0.113.7" });

  it("reads CF-Connecting-IP through Cloudflare's live ranges", async () => {
    expect(await clientIpFor(viaCloudflare)).toBe("203.0.113.7");
  });

  it("keys by the edge when VARDO_TRUST_CLOUDFLARE opts out", async () => {
    vi.stubEnv("VARDO_TRUST_CLOUDFLARE", "false");
    expect(await clientIpFor(viaCloudflare)).toBe("172.70.1.2");
    vi.unstubAllEnvs();
  });
});

describe("cidrMatcher", () => {
  const match = cidrMatcher(["173.245.48.0/20", "2400:cb00::/32"]);

  it("matches both families and nothing else", () => {
    expect(match("173.245.63.255")).toBe(true);
    expect(match("173.245.64.0")).toBe(false);
    expect(match("2400:cb00:1::1")).toBe(true);
    expect(match("2400:cb01::1")).toBe(false);
    expect(match("::ffff:173.245.48.1")).toBe(true);
    expect(match("not an ip")).toBe(false);
  });
});

describe("proxy rate limit by vetted address", () => {
  const hit = (peer: string, i: number) =>
    proxy(new NextRequest("http://vardo-frontend:3000/api/v1/whatever", {
      headers: { [PEER_HEADER]: peer, "x-forwarded-for": `10.9.${Math.floor(i / 250)}.${i % 250}` },
    }));

  it("limits an app that rotates a forged X-Forwarded-For", async () => {
    let last = 0;
    for (let i = 0; i < 201; i++) last = (await hit(APP, i)).status;
    expect(last).toBe(429);
  });

  it("keeps separate buckets for real clients behind Traefik", async () => {
    let last = 0;
    for (let i = 0; i < 201; i++) last = (await hit(TRAEFIK, i)).status;
    expect(last).toBe(200);
  });

  it("trusts nothing when Docker can't name Traefik", async () => {
    const { traefikAddresses } = await import("@/lib/security/client-ip");
    dockerRequestMock.mockRejectedValue(new Error("no socket"));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    expect((await traefikAddresses()).size).toBe(0);
    vi.useRealTimers();
  });
});

describe("peer-address preload", () => {
  let child: ChildProcess;
  let port = 0;

  beforeAll(async () => {
    const server = `require("http").createServer((req, res) => res.end(JSON.stringify([req.headers["${PEER_HEADER}"], req.rawHeaders]))).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`;
    child = spawn(process.execPath, ["--import", join(process.cwd(), "scripts/peer-address.mjs"), "-e", server]);
    port = await new Promise<number>((resolve) => child.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
  });
  afterAll(() => child.kill());

  it("replaces a client-sent peer header with the socket's address", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ port, host: "127.0.0.1", headers: { [PEER_HEADER]: TRAEFIK, "X-Vardo-Peer": TRAEFIK } }, (res) => {
        let s = "";
        res.on("data", (c) => (s += c)).on("end", () => resolve(s));
      });
      req.on("error", reject).end();
    });
    const [peer, raw] = JSON.parse(body) as [string, string[]];
    expect(peer).toBe("127.0.0.1");
    expect(raw.filter((v, i) => i % 2 === 0 && v.toLowerCase() === PEER_HEADER)).toHaveLength(1);
    expect(raw).not.toContain(TRAEFIK);
  });
});
