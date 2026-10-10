// Backoff delays, Retry-After parsing and rate-limit headers.

import { describe, it, expect, vi, afterEach } from "vitest";
import { backoffDelay, capDelay, parseRetryAfter, retryAfterMs, sleep } from "@/lib/net/backoff";

afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelay", () => {
  const opts = { baseMs: 100, maxMs: 1_000 };

  it("doubles per attempt and caps at maxMs", () => {
    const none = { ...opts, jitter: "none" as const };
    expect([1, 2, 3, 4, 5, 60].map((a) => backoffDelay(a, none))).toEqual([100, 200, 400, 800, 1_000, 1_000]);
  });

  it("keeps full jitter within 0..ceiling", () => {
    expect(backoffDelay(3, { ...opts, random: () => 0 })).toBe(0);
    expect(backoffDelay(3, { ...opts, random: () => 1 })).toBe(400);
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(4, opts);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(800);
    }
  });

  it("keeps equal jitter within ceiling/2..ceiling", () => {
    expect(backoffDelay(3, { ...opts, jitter: "equal", random: () => 0 })).toBe(200);
    expect(backoffDelay(3, { ...opts, jitter: "equal", random: () => 1 })).toBe(400);
  });

  it("never goes under minMs", () => {
    expect(backoffDelay(1, { ...opts, minMs: 100, random: () => 0 })).toBe(100);
    expect(backoffDelay(3, { ...opts, minMs: 100, random: () => 0.5 })).toBe(250);
  });

  it("clamps a random source outside 0..1", () => {
    expect(backoffDelay(2, { ...opts, random: () => 5 })).toBe(200);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("1.5", now)).toBe(1_500);
  });

  it("reads an HTTP-date", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:01:30 GMT", now)).toBe(90_000);
  });

  it("treats a past date as no wait", () => {
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
  });

  it("ignores missing and garbage values", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
});

describe("retryAfterMs", () => {
  const now = 1_800_000_000_000;

  it("prefers Retry-After", () => {
    const headers = new Headers({ "retry-after": "7", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000100" });
    expect(retryAfterMs(headers, now)).toBe(7_000);
  });

  it("waits for GitHub's reset once the window is spent", () => {
    const headers = new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000060" });
    expect(retryAfterMs(headers, now)).toBe(60_000);
  });

  it("ignores the reset while requests remain", () => {
    expect(retryAfterMs(new Headers({ "x-ratelimit-remaining": "12", "x-ratelimit-reset": "1800000060" }), now)).toBeNull();
  });

  it("reads the IETF ratelimit headers as delta-seconds", () => {
    expect(retryAfterMs(new Headers({ "ratelimit-remaining": "0;w=21600", "ratelimit-reset": "30" }), now)).toBe(30_000);
  });

  it("accepts a plain header record, any case", () => {
    expect(retryAfterMs({ "Retry-After": "2" }, now)).toBe(2_000);
    expect(retryAfterMs({ "X-RateLimit-Remaining": ["0"], "X-RateLimit-Reset": "1800000001" }, now)).toBe(1_000);
  });

  it("is null when nothing asks for a wait", () => {
    expect(retryAfterMs(new Headers(), now)).toBeNull();
    expect(retryAfterMs(undefined, now)).toBeNull();
  });
});

describe("capDelay", () => {
  it("clamps to 0..max", () => {
    expect(capDelay(5_000, 1_000)).toBe(1_000);
    expect(capDelay(-1, 1_000)).toBe(0);
    expect(capDelay(500, 1_000)).toBe(500);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void sleep(1_000).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });

  it("rejects with the abort reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("rejects at once on an aborted signal", async () => {
    await expect(sleep(10, AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
  });
});
