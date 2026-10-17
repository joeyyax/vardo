import { describe, expect, it, vi } from "vitest";
import {
  evaluate,
  generateKeyPair,
  isPrivateAddress,
  resultBatch,
  signRecord,
  summarize,
  verifyRecord,
  watchList,
  type CheckResult,
  type VantagePoint,
} from "@/lib/uptime/core";
import { checkWatchedBatch } from "@/lib/uptime/batch";
import { classifyHost, publicEntries } from "@/lib/uptime/net";

const LOCAL: VantagePoint = { id: "local", name: "This instance", kind: "local" };
const EXT_A: VantagePoint = { id: "ext_a", name: "Frankfurt", kind: "external" };
const EXT_B: VantagePoint = { id: "ext_b", name: "Oregon", kind: "external" };

const NOW = Date.UTC(2026, 0, 10, 12, 0, 30);

function r(vantageId: string, ageSec: number, ok: boolean, error?: CheckResult["error"]): CheckResult {
  return { monitorId: "m1", vantageId, at: NOW - ageSec * 1000, ok, latencyMs: 80, ...(error ? { error } : {}) };
}

const DNS: Record<string, string[]> = {
  "shop.example.com": ["93.184.216.34"],
  "intranet.example.com": ["10.0.4.7"],
  "tunnel.example.com": ["10.99.0.3"],
  "mixed.example.com": ["93.184.216.34", "192.168.1.5"],
  "v6.example.com": ["2606:2800:220:1:248:1893:25c8:1946"],
};
const resolve = async (host: string) => {
  if (!DNS[host]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return DNS[host];
};

describe("private addresses", () => {
  it.each(["10.1.2.3", "10.99.0.2", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "[::1]", "not-an-ip"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("watch list filter", () => {
  const http = (url: string) => ({ type: "http" as const, url, expectedStatus: { min: 200, max: 399 }, timeoutMs: 10_000 });

  it("classifies hosts by what they resolve to", async () => {
    expect(await classifyHost("shop.example.com", resolve)).toBe("public");
    expect(await classifyHost("intranet.example.com", resolve)).toBe("private");
    expect(await classifyHost("tunnel.example.com", resolve)).toBe("private");
    expect(await classifyHost("mixed.example.com", resolve)).toBe("private");
    expect(await classifyHost("gone.example.com", resolve)).toBe("unresolved");
    expect(await classifyHost("localhost", resolve)).toBe("private");
    expect(await classifyHost("db", resolve)).toBe("private");
    expect(await classifyHost("printer.local", resolve)).toBe("private");
    expect(await classifyHost("10.99.0.4", resolve)).toBe("private");
    expect(await classifyHost("93.184.216.34", resolve)).toBe("public");
  });

  it("keeps public monitors and leaves out private, loopback, link-local and mesh hosts", async () => {
    const lookups = vi.fn(resolve);
    const entries = await publicEntries(
      [
        { id: "web", check: http("https://shop.example.com/health"), intervalSec: 60 },
        { id: "v6", check: http("https://v6.example.com"), intervalSec: 30 },
        { id: "lan", check: http("https://intranet.example.com"), intervalSec: 60 },
        { id: "mesh", check: http("http://tunnel.example.com"), intervalSec: 60 },
        { id: "mesh-ip", check: http("http://10.99.0.2:3000/api/health"), intervalSec: 60 },
        { id: "loopback", check: http("http://127.0.0.1:3000"), intervalSec: 60 },
        { id: "metadata", check: { type: "tcp", host: "169.254.169.254", port: 80 }, intervalSec: 60 },
        { id: "localhost", check: { type: "tls", host: "localhost", port: 443, warnDays: 14 }, intervalSec: 300 },
        { id: "bracketed", check: http("http://[::1]:8080"), intervalSec: 60 },
        { id: "tcp", check: { type: "tcp", host: "shop.example.com", port: 5432 }, intervalSec: 300 },
        { id: "unresolvable", check: http("https://gone.example.com"), intervalSec: 60 },
      ],
      lookups,
    );
    expect(entries.map((e) => e.monitorId)).toEqual(["web", "v6", "tcp"]);
    expect(entries[0]).toMatchObject({ intervalSec: 60, check: { type: "http" } });
  });
});

describe("signed batches", () => {
  const keys = generateKeyPair();
  const other = generateKeyPair();
  const batch = resultBatch("remote-1", [{ ...r("remote-1", 5, true) }], NOW);

  it("verifies against the announced key and refuses another or a changed payload", () => {
    const signed = signRecord(batch, keys.privateKey);
    expect(verifyRecord(signed, keys.publicKey)).toMatchObject({ kind: "results", vantageId: "remote-1" });
    expect(verifyRecord(signed, other.publicKey)).toBeNull();
    expect(verifyRecord({ ...signed, payload: signed.payload.replace('"ok":true', '"ok":false') }, keys.publicKey)).toBeNull();
    expect(verifyRecord({ ...signed, sig: "AAAA" }, keys.publicKey)).toBeNull();
  });

  it("signs and verifies a watch list", () => {
    const signed = signRecord(watchList("remote-1", [], NOW), keys.privateKey);
    expect(verifyRecord(signed, keys.publicKey)).toMatchObject({ kind: "watch", monitors: [] });
  });

  it("refuses results for monitors that aren't on the watch list", () => {
    const watching = new Set(["m1"]);
    expect(checkWatchedBatch([r("remote-1", 5, true)], "remote-1", watching, NOW)).toBeNull();
    expect(checkWatchedBatch([{ ...r("remote-1", 5, true), monitorId: "someone-elses" }], "remote-1", watching, NOW)).toBe("monitor not watched");
    expect(checkWatchedBatch([r("remote-1", 5, true)], "remote-1", new Set(), NOW)).toBe("monitor not watched");
  });

  it("refuses another vantage point's results, stale or future timestamps and empty batches", () => {
    const watching = new Set(["m1"]);
    expect(checkWatchedBatch([r("remote-2", 5, true)], "remote-1", watching, NOW)).toBe("wrong vantage point");
    expect(checkWatchedBatch([r("remote-1", 15 * 86_400, true)], "remote-1", watching, NOW)).toBe("timestamp out of range");
    expect(checkWatchedBatch([r("remote-1", -3600, true)], "remote-1", watching, NOW)).toBe("timestamp out of range");
    expect(checkWatchedBatch([], "remote-1", watching, NOW)).toBe("empty batch");
  });
});

describe("agreement with local and external data", () => {
  const vantages = [LOCAL, EXT_A, EXT_B];
  const decide = (results: CheckResult[]) => evaluate({ vantages, results, now: NOW, intervalSec: 60 });

  it("goes unknown when an external vantage point stops delivering", () => {
    const stale = [r("ext_a", 400, true), r("ext_a", 460, true)];
    const result = evaluate({ vantages: [LOCAL, EXT_A], results: stale, now: NOW, intervalSec: 60 });
    expect(result.state).toBe("unknown");
    expect(result.vantages.find((v) => v.vantage.id === "ext_a")?.state).toBe("unknown");
  });

  it("doesn't count a quiet external vantage point as up", () => {
    const results = [r("ext_a", 10, false), r("ext_a", 40, false), r("ext_b", 400, true), r("ext_b", 460, true)];
    const evaluation = decide(results);
    expect(evaluation.state).toBe("down");
    expect(evaluation.vantages.find((v) => v.vantage.id === "ext_b")?.state).toBe("unknown");
  });

  it("falls back to local, flagged local only, when every external vantage point is quiet", () => {
    const results = [r("local", 10, false), r("local", 40, false), r("ext_a", 900, true)];
    const evaluation = decide(results);
    expect(evaluation).toMatchObject({ state: "down", localOnly: true });
  });

  it("ignores a failing local vantage point while an external one reports up", () => {
    const results = [r("local", 10, false), r("local", 40, false), r("ext_a", 20, true)];
    expect(decide(results)).toMatchObject({ state: "up", localOnly: false });
  });

  it("needs most external vantage points to fail", () => {
    const oneOfTwo = [r("ext_a", 10, false), r("ext_a", 40, false), r("ext_b", 20, true)];
    expect(decide(oneOfTwo).state).toBe("up");
    const both = [...oneOfTwo.slice(0, 2), r("ext_b", 10, false), r("ext_b", 40, false)];
    expect(decide(both)).toMatchObject({ state: "down", localOnly: false });
  });

  it("treats private-address results as no data", () => {
    const skipped = [r("ext_a", 10, false, "private-address"), r("ext_a", 40, false, "private-address")];
    const evaluation = decide(skipped);
    expect(evaluation.vantages.find((v) => v.vantage.id === "ext_a")?.state).toBe("unknown");
    expect(evaluation.state).toBe("unknown");

    const buckets = summarize({ results: skipped, vantages, intervalSec: 60, from: NOW - 3_600_000, to: NOW, bucketMs: 3_600_000 });
    expect(buckets.every((b) => b.minutesUp === 0 && b.minutesDown === 0)).toBe(true);
  });

  it("lets a good check after skipped ones count again", () => {
    const results = [r("ext_a", 5, true), r("ext_a", 35, false, "private-address"), r("ext_a", 65, false, "private-address")];
    expect(decide(results)).toMatchObject({ state: "up", localOnly: false });
  });
});
