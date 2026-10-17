import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluate,
  judgePeerLink,
  summarize,
  HOUR_MS,
  type CheckPath,
  type CheckResult,
  type PeerSignals,
  type VantagePoint,
} from "@/lib/uptime/core";
import { checkWatchedBatch } from "@/lib/uptime/batch";
import { incidentTitle, meshNote, pathLabel, readingDetail, readingLabel } from "@/lib/uptime/format";
import { tunnelAddress, tunnelDeps } from "@/lib/uptime/mesh-path";
import { isNeverPublic } from "@/lib/uptime/core";
import { meshCarries, privateEntries } from "@/lib/uptime/net";
import { probeEntry } from "@/lib/uptime/probe-entry";

const LOCAL: VantagePoint = { id: "local", name: "This instance", kind: "local" };
const FRA: VantagePoint = { id: "fra", name: "Frankfurt", kind: "external" };
const ORE: VantagePoint = { id: "ore", name: "Oregon", kind: "external" };
const TYO: VantagePoint = { id: "tyo", name: "Tokyo", kind: "external" };
const NOW = Date.UTC(2026, 0, 10, 12, 0, 30);

function r(vantageId: string, path: CheckPath, ok: boolean, ageSec = 0): CheckResult {
  return { monitorId: "m", vantageId, path, at: NOW - ageSec * 1000, ok, latencyMs: 90, ...(ok ? { status: 200 } : { error: "timeout" as const }) };
}
/** Two results in a row, so a failure counts. */
const run = (vantageId: string, path: CheckPath, ok: boolean) => [r(vantageId, path, ok, 60), r(vantageId, path, ok, 0)];
const ev = (vantages: VantagePoint[], results: CheckResult[]) => evaluate({ vantages, results, now: NOW, intervalSec: 60 });

describe("path weighting", () => {
  it("lets public external results decide over mesh and local", () => {
    const e = ev([LOCAL, FRA, ORE], [...run("fra", "public", true), ...run("ore", "mesh", false), ...run("local", "local", false)]);
    expect(e.state).toBe("degraded");
    expect(e.localOnly).toBe(false);
  });

  it("lets mesh results decide a private monitor", () => {
    expect(ev([LOCAL, ORE], [...run("ore", "mesh", true), ...run("local", "local", true)])).toMatchObject({ state: "up", localOnly: false });
    expect(ev([LOCAL, ORE], [...run("ore", "mesh", false), ...run("local", "local", false)])).toMatchObject({ state: "down", localOnly: false });
  });

  it("breaks ties with the local result only when no other path is current", () => {
    const stale = [r("ore", "mesh", true, 3600), r("ore", "mesh", true, 3660)];
    expect(ev([LOCAL, ORE], [...stale, ...run("local", "local", false)])).toMatchObject({ state: "down", localOnly: true });
    expect(ev([LOCAL, ORE], [...stale, ...run("local", "local", true)])).toMatchObject({ state: "up", localOnly: true });
  });

  it("keeps a vantage point's streaks on each path apart", () => {
    const e = ev([FRA], [r("fra", "public", false, 60), r("fra", "mesh", false, 30), r("fra", "public", false, 0)]);
    const byPath = Object.fromEntries(e.vantages.map((s) => [s.path, s.state]));
    expect(byPath).toEqual({ public: "failing", mesh: "up" });
  });

  it("counts a result with an unknown outcome as no data", () => {
    const blocked = [{ ...r("ore", "mesh", false, 60), error: "blocked" as const }, { ...r("ore", "mesh", false, 0), error: "blocked" as const }];
    expect(ev([LOCAL, ORE], [...blocked, ...run("local", "local", true)])).toMatchObject({ state: "up", localOnly: true });
  });
});

describe("disagreement", () => {
  it("is degraded when the deciding vantage points split, naming who fails", () => {
    const e = ev([LOCAL, FRA, ORE, TYO], [...run("fra", "public", false), ...run("ore", "public", true), ...run("tyo", "public", true), ...run("local", "local", true)]);
    expect(e).toMatchObject({ state: "degraded", reading: { kind: "vantage-failing", vantages: ["Frankfurt"] } });
    expect(e.downSince).toBeUndefined();
  });

  it("names every failing vantage point in a minority", () => {
    const four = [...run("fra", "public", false), ...run("ore", "public", false), ...run("tyo", "public", true), ...run("local", "local", true)];
    const wide = [{ ...TYO, id: "x1", name: "Sydney" }, { ...TYO, id: "x2", name: "Lima" }];
    const e = ev([LOCAL, FRA, ORE, TYO, ...wide], [...four, ...run("x1", "public", true), ...run("x2", "public", true)]);
    expect(e).toMatchObject({ state: "degraded", reading: { kind: "vantage-failing", vantages: ["Frankfurt", "Oregon"] } });
  });

  it("reads 'unreachable from outside' when public checks fail and local and mesh succeed", () => {
    const e = ev([LOCAL, FRA, ORE], [...run("fra", "public", false), ...run("ore", "public", false), ...run("local", "local", true)]);
    expect(e).toMatchObject({ state: "down", reading: { kind: "unreachable-outside" } });
    const withMesh = ev([LOCAL, FRA, ORE], [...run("fra", "public", false), ...run("ore", "mesh", true)]);
    expect(withMesh).toMatchObject({ state: "degraded", reading: { kind: "unreachable-outside" } });
  });

  it("never calls a single outside vantage point's failure an outage while local succeeds", () => {
    const one = ev([LOCAL, FRA], [...run("fra", "public", false), ...run("local", "local", true)]);
    expect(one).toMatchObject({ state: "degraded", reading: { kind: "unreachable-outside" } });
    expect(one.downSince).toBeUndefined();
    // Local failing too is agreement, so it is down.
    expect(ev([LOCAL, FRA], [...run("fra", "public", false), ...run("local", "local", false)]).state).toBe("down");
  });

  it("reads 'failing from this instance only' when local fails and the others succeed", () => {
    const e = ev([LOCAL, FRA], [...run("local", "local", false), ...run("fra", "public", true)]);
    expect(e).toMatchObject({ state: "degraded", reading: { kind: "local-only" }, localOnly: false });
    const viaMesh = ev([LOCAL, ORE], [...run("local", "local", false), ...run("ore", "mesh", true)]);
    expect(viaMesh).toMatchObject({ state: "degraded", reading: { kind: "local-only" } });
  });

  it("reads 'unreachable over the mesh' as a warning when the mesh fails and local succeeds", () => {
    const e = ev([LOCAL, ORE], [...run("ore", "mesh", false), ...run("local", "local", true)]);
    expect(e).toMatchObject({ state: "degraded", reading: { kind: "unreachable-mesh" } });
  });

  it("flags a failing mesh check on a public monitor", () => {
    const e = ev([LOCAL, FRA, ORE], [...run("fra", "public", true), ...run("ore", "mesh", false), ...run("local", "local", true)]);
    expect(e).toMatchObject({ state: "degraded", reading: { kind: "vantage-failing", vantages: ["Oregon"] } });
  });

  it("has no reading when everything agrees", () => {
    expect(ev([LOCAL, FRA], [...run("fra", "public", true), ...run("local", "local", true)]).reading).toBeUndefined();
    expect(ev([LOCAL, FRA], [...run("fra", "public", false), ...run("local", "local", false)])).toMatchObject({ state: "down" });
    expect(ev([LOCAL, FRA], [...run("fra", "public", false), ...run("local", "local", false)]).reading).toBeUndefined();
  });

  it("is still down when most deciding vantage points fail", () => {
    const e = ev([LOCAL, FRA, ORE, TYO], [...run("fra", "public", false), ...run("ore", "public", false), ...run("tyo", "public", true)]);
    expect(e.state).toBe("down");
    expect(e.downSince).toBe(NOW - 60_000);
  });
});

describe("copy", () => {
  it("words each reading and incident title", () => {
    expect(readingLabel({ kind: "unreachable-outside" })).toBe("Unreachable from outside");
    expect(readingLabel({ kind: "local-only" })).toBe("Failing from this instance only");
    expect(readingLabel({ kind: "vantage-failing", vantages: ["Frankfurt"] })).toBe("Failing from Frankfurt");
    expect(readingLabel({ kind: "vantage-failing", vantages: ["Frankfurt", "Oregon"] })).toBe("Failing from Frankfurt and Oregon");
    expect(readingDetail({ kind: "unreachable-outside" })).toMatch(/DNS, the certificate, the CDN or a firewall/);
    expect(incidentTitle("shop.example.com", "down")).toBe("shop.example.com is down");
    expect(incidentTitle("shop.example.com", "down", { kind: "unreachable-outside" })).toBe("shop.example.com is unreachable from outside");
    expect(incidentTitle("shop.example.com", "degraded", { kind: "local-only" })).toBe("shop.example.com is failing from this instance only");
    expect(incidentTitle("shop.example.com", "degraded", { kind: "vantage-failing", vantages: ["Oregon"] })).toBe("shop.example.com is failing from Oregon");
  });

  it("labels the path of each vantage row and the mesh note", () => {
    expect(pathLabel("external", "public")).toBe("External · public");
    expect(pathLabel("external", "mesh")).toBe("External · mesh");
    expect(pathLabel("local", "local")).toBe("Local");
    expect(meshNote(["jy0"])).toBe("Checked over the mesh by jy0");
    expect(meshNote([])).toBeNull();
  });
});

describe("summaries by path", () => {
  const start = Date.UTC(2026, 0, 10, 10, 0, 0);
  const minutes = (vantageId: string, path: CheckPath, ok: boolean): CheckResult[] =>
    Array.from({ length: 60 }, (_, i) => ({ monitorId: "m", vantageId, path, at: start + i * 60_000, ok, latencyMs: 80 }));
  const hour = (results: CheckResult[], publicOnly = false) =>
    summarize({ results, vantages: [LOCAL, FRA, ORE], intervalSec: 60, from: start, to: start + HOUR_MS, bucketMs: HOUR_MS, publicOnly })[0];

  it("weighs public over mesh over local", () => {
    expect(hour([...minutes("fra", "public", true), ...minutes("ore", "mesh", false), ...minutes("local", "local", false)])).toMatchObject({ minutesUp: 60, minutesDown: 0 });
    expect(hour([...minutes("ore", "mesh", true), ...minutes("local", "local", false)])).toMatchObject({ minutesUp: 60, minutesDown: 0 });
    expect(hour([...minutes("local", "local", false)])).toMatchObject({ minutesUp: 0, minutesDown: 60 });
  });

  it("counts public-path results only for public uptime", () => {
    const mesh = minutes("ore", "mesh", true);
    expect(hour([...mesh, ...minutes("local", "local", true)], true)).toMatchObject({ minutesUp: 0, minutesDown: 0, minutesUnknown: 60, uptimePct: null });
    expect(hour([...mesh, ...minutes("fra", "public", false)], true)).toMatchObject({ minutesDown: 60 });
  });
});

describe("peer link verdicts", () => {
  const base: PeerSignals = { peer: "jy0", self: "Long House", tunnel: "up", publicUrl: "up", heartbeatFresh: true };
  const judge = (over: Partial<PeerSignals>) => judgePeerLink({ ...base, ...over });

  it("is fine when the tunnel answers", () => {
    expect(judge({})).toMatchObject({ kind: "ok", state: "up" });
  });

  it("calls a dead tunnel with an answering public URL a link problem", () => {
    expect(judge({ tunnel: "down" })).toMatchObject({ kind: "link-down", state: "down", title: "Link to jy0 is down" });
  });

  it("calls a peer down when neither path answers", () => {
    expect(judge({ tunnel: "down", publicUrl: "down" })).toMatchObject({ kind: "peer-down", title: "jy0 is down" });
  });

  it("says unreachable when the tunnel is dead and there's no public URL", () => {
    expect(judge({ tunnel: "down", publicUrl: "none", peer: "Long House", self: "jy0" })).toMatchObject({
      kind: "unreachable",
      title: "Long House unreachable from jy0",
    });
  });

  it("warns when only the public URL is failing", () => {
    expect(judge({ publicUrl: "down" })).toMatchObject({ kind: "public-down", state: "degraded" });
  });

  it("reads a stale heartbeat as a dead tunnel while the tunnel check has no data", () => {
    expect(judge({ tunnel: "unknown", heartbeatFresh: false })).toMatchObject({ kind: "link-down" });
    expect(judge({ tunnel: "unknown", heartbeatFresh: true }).state).toBe("unknown");
    expect(judge({ tunnel: "up", heartbeatFresh: false }).kind).toBe("ok");
  });
});

describe("watch list classification", () => {
  const http1 = (url: string) => ({ type: "http" as const, url, expectedStatus: { min: 200, max: 399 }, timeoutMs: 5000 });
  const resolve = async (host: string) => {
    const dns: Record<string, string[]> = {
      "app.example.com": ["192.168.1.20"],
      "split.example.com": ["93.184.216.34", "192.168.1.20"],
      "shop.example.com": ["93.184.216.34"],
    };
    if (!dns[host]) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    return dns[host];
  };

  it("lists hosts that resolve only to private addresses, as mesh checks", async () => {
    const monitors = [
      { id: "private", check: http1("https://app.example.com/"), intervalSec: 60 },
      { id: "public", check: http1("https://shop.example.com/"), intervalSec: 60 },
      { id: "split", check: http1("https://split.example.com/"), intervalSec: 60 },
      { id: "gone", check: http1("https://gone.example.com/"), intervalSec: 60 },
      { id: "literal", check: http1("http://192.168.1.5/"), intervalSec: 60 },
      { id: "lan", check: http1("https://nas.lan/"), intervalSec: 60 },
      { id: "port", check: http1("https://app.example.com:8443/"), intervalSec: 60 },
      { id: "db", check: { type: "tcp" as const, host: "app.example.com", port: 5432 }, intervalSec: 60 },
      { id: "web", check: { type: "tcp" as const, host: "app.example.com", port: 443 }, intervalSec: 60 },
    ];
    const entries = await privateEntries(monitors, resolve);
    expect(entries.map((e) => [e.monitorId, e.path])).toEqual([
      ["private", "mesh"],
      ["lan", "mesh"],
      ["web", "mesh"],
    ]);
  });

  it("carries only names on the ports the tunnel forwards to Traefik", () => {
    expect(meshCarries(http1("https://app.example.com/"))).toBe(true);
    expect(meshCarries(http1("http://app.example.com/"))).toBe(true);
    expect(meshCarries(http1("https://app.example.com:8443/"))).toBe(false);
    expect(meshCarries(http1("https://192.168.1.5/"))).toBe(false);
    expect(meshCarries(http1("https://localhost/"))).toBe(false);
    expect(meshCarries({ type: "tls", host: "app.example.com", port: 443, warnDays: 14 })).toBe(true);
  });
});

describe("names that can't be public", () => {
  it.each(["plextraktsync.localhost", "localhost", "files.lan", "printer.local", "api.internal", "app.test", "nas", "a.b.LAN"])("%s", (host) => expect(isNeverPublic(host)).toBe(true));
  it.each(["example.com", "app.example.com", "test.example.com", "lan.example.com", "localhost.example.com", "10.0.0.5"])("%s is left alone", (host) =>
    expect(isNeverPublic(host)).toBe(false),
  );
});

describe("batch path check", () => {
  const okResult = (path: CheckPath): CheckResult => ({ ...r("ore", path, true), at: NOW });
  it("accepts a result only on the path it was served for", () => {
    const watching = new Set(["m"]);
    expect(checkWatchedBatch([okResult("public")], "ore", watching, NOW)).toBeNull();
    expect(checkWatchedBatch([okResult("mesh")], "ore", watching, NOW)).toBe("wrong path");
    expect(checkWatchedBatch([okResult("mesh")], "ore", watching, NOW, new Set(["m"]))).toBeNull();
    expect(checkWatchedBatch([okResult("public")], "ore", watching, NOW, new Set(["m"]))).toBe("wrong path");
    expect(checkWatchedBatch([okResult("local")], "ore", watching, NOW)).toBe("wrong path");
  });
});

describe("mesh path allowance", () => {
  afterEach(() => vi.restoreAllMocks());
  const PEER = "10.99.0.7";

  function fakeHttp(status = 200) {
    const calls: { host: string; port: number; headers: Record<string, string>; servername?: string }[] = [];
    vi.spyOn(http, "request").mockImplementation(((options: Record<string, unknown>, cb: (res: unknown) => void) => {
      calls.push({ host: String(options.host), port: Number(options.port), headers: options.headers as Record<string, string> });
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const res = Object.assign(Readable.from(["ok"]), { statusCode: status, headers: {}, statusMessage: "OK" });
        queueMicrotask(() => cb(res));
      };
      return req;
    }) as never);
    return calls;
  }

  function fakeTcp() {
    const calls: { host: string; port: number }[] = [];
    vi.spyOn(net, "connect").mockImplementation(((options: { host: string; port: number }) => {
      calls.push({ host: options.host, port: options.port });
      const socket = Object.assign(new EventEmitter(), { setTimeout: () => {}, destroy: () => {} });
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    }) as never);
    return calls;
  }

  const strict = { fetch: (() => Promise.reject(new Error("public path used"))) as unknown as typeof fetch, guard: async () => null };
  const entry = (check: unknown, path = "mesh") => ({ monitorId: "m", check: check as never, path });
  const page = { type: "http", url: "http://app.lan/health", expectedStatus: { min: 200, max: 399 }, timeoutMs: 2000 };

  it("lets a link check name the peer's own address, and no other", async () => {
    const calls = fakeHttp(200);
    const { fetch } = tunnelDeps(PEER, [3000]);
    const res = await fetch(`http://${PEER}:3000/api/health`);
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ host: PEER, port: 3000 });
    await expect(fetch("http://10.99.0.8:3000/api/health")).rejects.toThrow(/host names or the peer/);
  });

  it("accepts only a mesh address as a tunnel address", () => {
    expect(tunnelAddress("10.99.0.7")).toBe("10.99.0.7");
    expect(tunnelAddress("10.99.0.7/32")).toBe("10.99.0.7");
    for (const bad of ["192.168.1.5", "10.99.0.0", "10.99.0.255", "10.99.0.7/24", "10.98.0.7", "app.lan", "", null]) expect(tunnelAddress(bad)).toBeNull();
    expect(() => tunnelDeps("192.168.1.5")).toThrow();
  });

  it("connects an http check to the peer's tunnel address with the original Host header", async () => {
    const calls = fakeHttp();
    const result = await probeEntry(entry(page), { vantageId: "v", peerAddress: PEER, strict });
    expect(result).toMatchObject({ ok: true, path: "mesh", status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: PEER, port: 80, headers: { host: "app.lan" } });
  });

  it("keeps every redirect hop on the tunnel address", async () => {
    const calls: { host: string; headers: Record<string, string> }[] = [];
    vi.spyOn(http, "request").mockImplementation(((options: Record<string, unknown>, cb: (res: unknown) => void) => {
      calls.push({ host: String(options.host), headers: options.headers as Record<string, string> });
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const first = calls.length === 1;
        const res = Object.assign(Readable.from(["ok"]), {
          statusCode: first ? 302 : 200,
          headers: first ? { location: "http://192.168.1.99/elsewhere" } : {},
          statusMessage: "",
        });
        queueMicrotask(() => cb(res));
      };
      return req;
    }) as never);
    // A redirect to an address is refused outright; one to a name stays on the tunnel.
    const refused = await probeEntry(entry(page), { vantageId: "v", peerAddress: PEER, strict });
    expect(refused).toMatchObject({ ok: false, error: "blocked" });
    expect(calls.every((c) => c.host === PEER)).toBe(true);
  });

  it("refuses a watch entry that points anywhere else", async () => {
    const http1 = fakeHttp();
    const tcp = fakeTcp();
    const refuse = async (check: unknown, peerAddress: string | null = PEER) =>
      probeEntry(entry(check), { vantageId: "v", peerAddress, strict });

    // A LAN address in the check.
    expect(await refuse({ ...page, url: "http://192.168.1.50/" })).toMatchObject({ ok: false, error: "blocked", path: "mesh" });
    expect(await refuse({ ...page, url: "http://[fd00::5]/" })).toMatchObject({ ok: false, error: "blocked" });
    expect(await refuse({ type: "tcp", host: "192.168.1.50", port: 443 })).toMatchObject({ ok: false, error: "blocked" });
    // A port the tunnel doesn't forward.
    expect(await refuse({ ...page, url: "http://app.lan:8080/" })).toMatchObject({ ok: false, error: "blocked" });
    expect(await refuse({ type: "tcp", host: "db.example.com", port: 5432 })).toMatchObject({ ok: false, error: "blocked" });
    // No valid tunnel address for the peer.
    expect(await refuse(page, null)).toMatchObject({ ok: false, error: "blocked" });
    expect(await refuse(page, "192.168.1.1")).toMatchObject({ ok: false, error: "blocked" });

    expect(http1).toHaveLength(0);
    expect(tcp).toHaveLength(0);
  });

  it("connects a tcp check to the tunnel address and not the host in the entry", async () => {
    const calls = fakeTcp();
    const result = await probeEntry(entry({ type: "tcp", host: "db.example.com", port: 443 }), { vantageId: "v", peerAddress: PEER, strict });
    expect(result).toMatchObject({ ok: true, path: "mesh" });
    expect(calls).toEqual([{ host: PEER, port: 443 }]);
  });

  it("pins the sockets and fetch it hands out, whatever they're asked", async () => {
    const calls = fakeHttp();
    const tcp = fakeTcp();
    const deps = tunnelDeps(PEER);
    await deps.fetch("http://anything.lan/x");
    expect(calls[0].host).toBe(PEER);
    await expect(deps.fetch("http://10.0.0.5/")).rejects.toMatchObject({ name: "BlockedUrlError" });
    await expect(deps.fetch("ftp://app.lan/")).rejects.toMatchObject({ name: "BlockedUrlError" });
    deps.netConnect({ host: "192.168.1.9", port: 443 } as never);
    expect(tcp).toEqual([{ host: PEER, port: 443 }]);
  });

  it("checks public entries over the public path", async () => {
    const used: string[] = [];
    const publicStrict = { fetch: (async (u: string) => (used.push(u), new Response("ok"))) as unknown as typeof fetch, guard: async () => null };
    const result = await probeEntry(
      entry({ ...page, url: "https://shop.example.com/" }, "public"),
      { vantageId: "v", peerAddress: PEER, strict: publicStrict, deps: { resolve: async () => ["93.184.216.34"] } },
    );
    expect(result).toMatchObject({ ok: true, path: "public" });
    expect(used).toEqual(["https://shop.example.com/"]);
    const lan = await probeEntry(entry({ ...page, url: "https://app.lan/" }, "public"), { vantageId: "v", peerAddress: PEER, strict: publicStrict });
    expect(lan).toMatchObject({ ok: false, error: "private-address", path: "public" });
  });
});
