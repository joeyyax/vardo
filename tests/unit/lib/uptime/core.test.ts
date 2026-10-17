import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  combine,
  evaluate,
  findOutages,
  fillDays,
  generateKeyPair,
  hourlySummary,
  resultBatch,
  runHttpCheck,
  runTcpCheck,
  runTlsCheck,
  signRecord,
  summarize,
  verifyRecord,
  type CheckResult,
  type VantagePoint,
} from "@/lib/uptime/core";

const LOCAL: VantagePoint = { id: "local", name: "This instance", kind: "local" };
const EXT_A: VantagePoint = { id: "a", name: "Frankfurt", kind: "external" };
const EXT_B: VantagePoint = { id: "b", name: "Oregon", kind: "external" };
const EXT_C: VantagePoint = { id: "c", name: "Tokyo", kind: "external" };

const NOW = Date.UTC(2026, 0, 10, 12, 0, 30);

function r(vantageId: string, ageSec: number, ok: boolean, latencyMs = 100): CheckResult {
  return { monitorId: "m", vantageId, path: vantageId === "local" ? "local" : "public", at: NOW - ageSec * 1000, ok, latencyMs, ...(ok ? { status: 200 } : { error: "timeout" as const }) };
}

describe("agreement", () => {
  const run = (vantages: VantagePoint[], results: CheckResult[]) => evaluate({ vantages, results, now: NOW, intervalSec: 60 });

  it("is unknown without current data", () => {
    expect(run([LOCAL], []).state).toBe("unknown");
    expect(run([LOCAL], [r("local", 600, true)]).state).toBe("unknown");
  });

  it("needs two failures in a row from one vantage point", () => {
    expect(run([LOCAL], [r("local", 60, true), r("local", 0, false)]).state).toBe("up");
    const two = run([LOCAL], [r("local", 120, true), r("local", 60, false), r("local", 0, false)]);
    expect(two.state).toBe("down");
    expect(two.downSince).toBe(NOW - 60_000);
  });

  it("lets local decide, flagged localOnly, with no external vantage points", () => {
    const e = run([LOCAL], [r("local", 60, false), r("local", 0, false)]);
    expect(e).toMatchObject({ state: "down", localOnly: true });
  });

  it("is down when most external vantage points fail", () => {
    const fail = (id: string) => [r(id, 60, false), r(id, 0, false)];
    const ok = (id: string) => [r(id, 60, true), r(id, 0, true)];
    const vantages = [LOCAL, EXT_A, EXT_B, EXT_C];
    expect(run(vantages, [...fail("a"), ...fail("b"), ...ok("c"), ...ok("local")])).toMatchObject({ state: "down", localOnly: false });
    expect(run(vantages, [...fail("a"), ...ok("b"), ...ok("c"), ...fail("local")]).state).toBe("degraded");
  });

  it("doesn't let a failing local vantage point decide once externals report, but says so", () => {
    const e = run(
      [LOCAL, EXT_A],
      [r("local", 60, false), r("local", 0, false), r("a", 60, true), r("a", 0, true)],
    );
    expect(e).toMatchObject({ state: "degraded", reading: { kind: "local-only" }, localOnly: false });
  });

  it("falls back to local when external vantage points are silent", () => {
    const e = run([LOCAL, EXT_A], [r("local", 60, false), r("local", 0, false), r("a", 3600, true)]);
    expect(e).toMatchObject({ state: "down", localOnly: true });
  });
});

describe("summaries", () => {
  const start = Date.UTC(2026, 0, 10, 10, 0, 0);
  const results = (okAt: (min: number) => boolean | null, minutes: number) =>
    Array.from({ length: minutes }, (_, i) => ({ i, ok: okAt(i) }))
      .filter((x) => x.ok !== null)
      .map(({ i, ok }) => ({ monitorId: "m", vantageId: "local", path: "local", at: start + i * 60_000, ok: ok!, latencyMs: 100 + i }) as CheckResult);

  it("counts minutes up, down and unknown", () => {
    // 0-39 ok, 40-49 failing, 50-59 no data.
    const data = results((i) => (i < 40 ? true : i < 50 ? false : null), 60);
    const [b] = summarize({ results: data, vantages: [LOCAL], intervalSec: 60, from: start, to: start + HOUR_MS, bucketMs: HOUR_MS });
    expect(b).toMatchObject({ minutesUp: 40, minutesDown: 10, minutesUnknown: 10, uptimePct: 80 });
  });

  it("never counts missing data as up", () => {
    const [b] = summarize({ results: [], vantages: [LOCAL], intervalSec: 60, from: start, to: start + HOUR_MS, bucketMs: HOUR_MS });
    expect(b).toMatchObject({ minutesUp: 0, minutesUnknown: 60, uptimePct: null, medianLatencyMs: null });
  });

  it("treats a lone failure as a blip", () => {
    const data = results((i) => i !== 20, 60);
    const [b] = summarize({ results: data, vantages: [LOCAL], intervalSec: 60, from: start, to: start + HOUR_MS, bucketMs: HOUR_MS });
    expect(b.minutesDown).toBe(0);
  });

  it("rounds to two decimals and takes the median latency", () => {
    const data = results((i) => i !== 5 && i !== 6, 60);
    const [b] = summarize({ results: data, vantages: [LOCAL], intervalSec: 60, from: start, to: start + HOUR_MS, bucketMs: HOUR_MS });
    expect(b.uptimePct).toBe(96.67);
    expect(b.medianLatencyMs).toBe(131);
  });

  it("covers a 5 minute interval with each result", () => {
    const data = [0, 5, 10].map((m) => ({ monitorId: "m", vantageId: "local", path: "local", at: start + m * 60_000, ok: true, latencyMs: 50 }) as CheckResult);
    const [b] = summarize({ results: data, vantages: [LOCAL], intervalSec: 300, from: start, to: start + 15 * 60_000, bucketMs: 15 * 60_000 });
    expect(b.minutesUp).toBe(15);
  });

  it("finds outages as runs of down minutes", () => {
    const data = results((i) => (i >= 10 && i < 20 ? false : true), 31);
    const found = findOutages({ results: data, vantages: [LOCAL], intervalSec: 60, from: start, to: start + 31 * 60_000 });
    expect(found).toEqual([{ start: start + 10 * 60_000, end: start + 20 * 60_000 }]);
    const ongoing = findOutages({ results: results((i) => i < 10, 25), vantages: [LOCAL], intervalSec: 60, from: start, to: start + 25 * 60_000 });
    expect(ongoing).toEqual([{ start: start + 10 * 60_000, end: null }]);
  });

  it("combines hours into a day and fills gaps as unknown", () => {
    const hours = summarize({ results: results(() => true, 60), vantages: [LOCAL], intervalSec: 60, from: start, to: start + 2 * HOUR_MS, bucketMs: HOUR_MS });
    const day = combine(hours, Date.UTC(2026, 0, 10));
    expect(day).toMatchObject({ minutesUp: 60, minutesUnknown: 60 });
    const days = fillDays([day], Date.UTC(2026, 0, 9), 3);
    expect(days.map((d) => d.minutesUp)).toEqual([0, 60, 0]);
    expect(days[0].minutesUnknown).toBe(DAY_MS / 60_000);
  });
});

describe("signing", () => {
  const keys = generateKeyPair();
  const batch = resultBatch("local", [r("local", 0, true)], NOW);

  it("verifies a signed batch and an hourly summary", () => {
    expect(verifyRecord(signRecord(batch, keys.privateKey), keys.publicKey)).toEqual(batch);
    const bucket = { start: NOW, minutesUp: 60, minutesDown: 0, minutesUnknown: 0, uptimePct: 100, medianLatencyMs: 90 };
    const hourly = hourlySummary("local", "m", bucket, NOW);
    expect(verifyRecord(signRecord(hourly, keys.privateKey), keys.publicKey)).toEqual(hourly);
  });

  it("rejects a changed payload, another key and a bad version", () => {
    const signed = signRecord(batch, keys.privateKey);
    expect(verifyRecord({ ...signed, payload: signed.payload.replace('"ok":true', '"ok":false') }, keys.publicKey)).toBeNull();
    expect(verifyRecord(signed, generateKeyPair().publicKey)).toBeNull();
    const v2 = signRecord({ ...batch, v: 2 } as unknown as typeof batch, keys.privateKey);
    expect(verifyRecord(v2, keys.publicKey)).toBeNull();
    expect(verifyRecord({ payload: "x", sig: "!!" }, keys.publicKey)).toBeNull();
  });
});

describe("runners", () => {
  const clock = () => {
    let t = 1000;
    return () => (t += 25);
  };
  const http = { type: "http" as const, url: "https://example.com", expectedStatus: { min: 200, max: 399 }, timeoutMs: 1000 };
  const ctx = { monitorId: "m", vantageId: "local", path: "local" as const };

  it("passes http on an expected status", async () => {
    const fetchFake = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const res = await runHttpCheck(http, { ...ctx, now: clock(), fetch: fetchFake });
    expect(res).toMatchObject({ ok: true, status: 204, latencyMs: 25 });
  });

  it("fails http on an unexpected status without keeping the body", async () => {
    const fetchFake = (async () => new Response("secret", { status: 503 })) as typeof fetch;
    const res = await runHttpCheck(http, { ...ctx, now: clock(), fetch: fetchFake });
    expect(res).toMatchObject({ ok: false, status: 503, error: "status" });
    expect(JSON.stringify(res)).not.toContain("secret");
  });

  it("checks the keyword", async () => {
    const fetchFake = (async () => new Response("all systems go")) as typeof fetch;
    expect((await runHttpCheck({ ...http, keyword: "systems" }, { ...ctx, fetch: fetchFake })).ok).toBe(true);
    expect(await runHttpCheck({ ...http, keyword: "nope" }, { ...ctx, fetch: fetchFake })).toMatchObject({ ok: false, error: "keyword" });
  });

  it("maps thrown errors to kinds", async () => {
    const throwing = (err: unknown) => (async () => { throw err; }) as typeof fetch;
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const dns = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) });
    expect((await runHttpCheck(http, { ...ctx, fetch: throwing(timeout) })).error).toBe("timeout");
    const res = await runHttpCheck(http, { ...ctx, fetch: throwing(dns) });
    expect(res.error).toBe("dns");
    expect(JSON.stringify(res)).not.toContain("fetch failed");
  });

  const fakeSocket = (event: string, payload?: unknown, extra: Record<string, unknown> = {}) => {
    const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
    s.setTimeout = () => s;
    s.destroy = () => s;
    Object.assign(s, extra);
    setImmediate(() => s.emit(event, payload));
    return s;
  };

  it("runs tcp against a fake socket", async () => {
    const ok = await runTcpCheck({ type: "tcp", host: "h", port: 5432 }, { ...ctx, connect: (() => fakeSocket("connect")) as never });
    expect(ok.ok).toBe(true);
    const refused = await runTcpCheck(
      { type: "tcp", host: "h", port: 5432 },
      { ...ctx, connect: (() => fakeSocket("error", Object.assign(new Error("x"), { code: "ECONNREFUSED" }))) as never },
    );
    expect(refused).toMatchObject({ ok: false, error: "refused" });
    const slow = await runTcpCheck({ type: "tcp", host: "h", port: 1 }, { ...ctx, connect: (() => fakeSocket("timeout")) as never });
    expect(slow.error).toBe("timeout");
  });

  it("reads the certificate expiry on tls", async () => {
    const now = Date.UTC(2026, 0, 1);
    const cert = (days: number) => ({ valid_to: new Date(now + days * DAY_MS).toUTCString() });
    const connectWith = (days: number) => (() => fakeSocket("secureConnect", undefined, { getPeerCertificate: () => cert(days) })) as never;
    const check = { type: "tls" as const, host: "h", port: 443, warnDays: 14 };
    expect(await runTlsCheck(check, { ...ctx, now: () => now, connect: connectWith(60) })).toMatchObject({ ok: true, certDaysLeft: 60 });
    expect(await runTlsCheck(check, { ...ctx, now: () => now, connect: connectWith(5) })).toMatchObject({ ok: false, error: "cert-expiring", certDaysLeft: 5 });
    expect(await runTlsCheck(check, { ...ctx, now: () => now, connect: connectWith(-2) })).toMatchObject({ ok: false, error: "cert-expired" });
  });
});
