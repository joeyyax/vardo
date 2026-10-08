// A request straight to the console can't choose its own rate-limit key with X-Forwarded-For (#889).

import { spawn, type ChildProcess } from "child_process";
import { request } from "http";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dockerRequestMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/docker/client", () => ({ dockerRequest: dockerRequestMock }));

const { resolveClientIp, PEER_HEADER } = await import("@/lib/security/client-ip");
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
