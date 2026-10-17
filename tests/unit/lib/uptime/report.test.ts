// Reports to linked peers: what goes in one, what a peer accepts, and when it counts as stopped.

import { describe, expect, it } from "vitest";
import {
  REPORT_STALE_MS,
  generateKeyPair,
  monitorReport,
  readReport,
  reportEntry,
  reportFreshness,
  reportObservation,
  signRecord,
  verifyRecord,
  type Check,
  type ReportedMonitor,
} from "@/lib/uptime/core";
import { containerState } from "@/lib/uptime/reports";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const secretCheck: Check = {
  type: "http",
  url: "https://admin:hunter2@jellyfin.yax.me:8096/web/index.html?api_key=abc123#settings",
  expectedStatus: { min: 200, max: 399 },
  keyword: "Jellyfin Server",
  timeoutMs: 5000,
  headers: { Authorization: "Bearer tok_live_42", "X-Emby-Token": "embytoken" },
};

const entry = (over: Partial<Parameters<typeof reportEntry>[0]> = {}) =>
  reportEntry({ monitorId: "m1", check: secretCheck, state: "up", latencyMs: 42, container: "healthy", outages: [], quiet: false, ...over })!;

describe("reportEntry", () => {
  it("names the host alone: no scheme, credentials, port, path, query, keyword or headers", () => {
    const e = entry();
    expect(e.host).toBe("jellyfin.yax.me");
    const wire = JSON.stringify(e);
    for (const leak of ["https", "admin", "hunter2", "8096", "/web", "index.html", "api_key", "abc123", "settings", "Jellyfin Server", "Authorization", "Bearer", "tok_live_42", "X-Emby-Token", "embytoken"]) {
      expect(wire).not.toContain(leak);
    }
    expect(Object.keys(e).sort()).toEqual(["container", "host", "latencyMs", "monitorId", "outages", "quiet", "state"]);
  });

  it("carries a TCP or TLS check's host without its port", () => {
    expect(entry({ check: { type: "tcp", host: "nas.lan", port: 5432 } }).host).toBe("nas.lan");
    expect(JSON.stringify(entry({ check: { type: "tls", host: "10.0.0.5", port: 8443, warnDays: 14 } }))).not.toContain("8443");
  });

  it("skips a monitor whose host isn't a bare name", () => {
    expect(reportEntry({ monitorId: "m", check: { type: "tcp", host: "db/../etc", port: 1 }, state: "up", latencyMs: null, container: null, outages: [], quiet: false })).toBeNull();
  });

  it("keeps the down time only while down, and the newest outages", () => {
    expect(entry({ state: "down", downSince: NOW - 60_000 }).downSince).toBe(NOW - 60_000);
    expect(entry({ state: "up", downSince: NOW - 60_000 })).not.toHaveProperty("downSince");
    const outages = Array.from({ length: 30 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 500 }));
    expect(entry({ outages }).outages).toHaveLength(20);
    expect(entry({ outages }).outages[0].start).toBe(10_000);
  });
});

describe("readReport", () => {
  const good = (monitors: unknown[], issuedAt = NOW) => readReport({ issuedAt, monitors }, NOW, null);

  it("accepts a well-formed report", () => {
    expect(good([entry()])).toEqual({ monitors: [entry()] });
  });

  it("refuses a monitor that carries a URL, a path, headers or a body", () => {
    const base = entry();
    for (const extra of [{ url: "https://jellyfin.yax.me/web" }, { headers: { Authorization: "x" } }, { body: "<html>" }, { path: "/admin" }, { error: "ECONNREFUSED 10.0.0.5:8096" }]) {
      expect(good([{ ...base, ...extra }])).toEqual({ error: "malformed monitor" });
    }
    for (const host of ["jellyfin.yax.me/web", "https://jellyfin.yax.me", "jellyfin.yax.me:8096", "jellyfin.yax.me?x=1", "user@jellyfin.yax.me", ""]) {
      expect(good([{ ...base, host }])).toEqual({ error: "malformed monitor" });
    }
  });

  it("refuses a report from the future, an old one, a replay and duplicate monitors", () => {
    expect(good([entry()], NOW + 10 * 60_000)).toEqual({ error: "timestamp out of range" });
    expect(good([entry()], NOW - 20 * 60_000)).toEqual({ error: "timestamp out of range" });
    expect(readReport({ issuedAt: NOW, monitors: [] }, NOW, NOW)).toEqual({ error: "older than the last report" });
    expect(good([entry(), entry()])).toEqual({ error: "duplicate monitor" });
  });

  it("verifies as a signed record of kind report", () => {
    const keys = generateKeyPair();
    const signed = signRecord(monitorReport("inst-A", [entry()], NOW), keys.privateKey);
    expect(verifyRecord(signed, keys.publicKey)).toMatchObject({ kind: "report", vantageId: "inst-A" });
    expect(verifyRecord({ ...signed, payload: signed.payload.replace('"up"', '"down"') }, keys.publicKey)).toBeNull();
  });
});

describe("watching a report", () => {
  it("feeds up, degraded and down to damping, and nothing for unknown or silenced monitors", () => {
    const m = (state: ReportedMonitor["state"], quiet = false) => reportObservation({ ...entry(), state, quiet });
    expect(m("down")).toEqual({ state: "down", key: "down" });
    expect(m("degraded")).toEqual({ state: "degraded", key: "degraded" });
    expect(m("up")).toEqual({ state: "up", key: "up" });
    expect(m("unknown")).toBeNull();
    expect(m("down", true)).toBeNull();
  });

  it("is stale once no report has arrived for two and a half minutes", () => {
    expect(reportFreshness(null, NOW)).toBe("none");
    expect(reportFreshness(NOW - REPORT_STALE_MS, NOW)).toBe("fresh");
    expect(reportFreshness(NOW - REPORT_STALE_MS - 1, NOW)).toBe("stale");
  });

  it("reads the container from the app's conditions", () => {
    const c = (kind: string) => ({ kind, severity: "critical", since: "", detail: "" }) as never;
    expect(containerState(null)).toBe("healthy");
    expect(containerState([c("memory-pressure")])).toBe("healthy");
    expect(containerState([c("unhealthy")])).toBe("unhealthy");
    expect(containerState([c("unhealthy"), c("crash-looping")])).toBe("crash-looping");
  });
});
