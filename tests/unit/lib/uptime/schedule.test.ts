import { describe, expect, it } from "vitest";
import { isDue, phaseOf, runCheck } from "@/lib/uptime/core";

const MIN = 60_000;

describe("isDue", () => {
  it("runs a monitor with no history right away", () => {
    expect(isDue("mon_a", 60, undefined, 1_000_000)).toBe(true);
  });

  it("runs once per interval at the monitor's offset", () => {
    const phase = phaseOf("mon_a", MIN);
    const base = 100 * MIN + phase;
    expect(isDue("mon_a", 60, base, base + MIN - 1)).toBe(false);
    expect(isDue("mon_a", 60, base, base + MIN)).toBe(true);
  });

  it("realigns monitors that last ran together", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `mon_${i}`);
    const last = 100 * MIN;
    const firstDue = ids.map((id) => {
      for (let t = last; t <= last + MIN; t += 10_000) if (isDue(id, 60, last, t)) return t;
      return null;
    });
    expect(new Set(firstDue).size).toBeGreaterThan(3);
  });
});

describe("runCheck retry", () => {
  const check = { type: "http" as const, url: "https://example.com", timeoutMs: 1000, expectedStatus: { min: 200, max: 399 } };
  const sleep = async () => {};

  it("retries a DNS failure once", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("lookup"), { code: "EAI_AGAIN" });
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;
    const r = await runCheck({ id: "m", check }, "local", { fetch, sleep });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("doesn't retry a bad status", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response("no", { status: 503 });
    }) as typeof globalThis.fetch;
    const r = await runCheck({ id: "m", check }, "local", { fetch, sleep });
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
  });
});
