// Retry loop: classification, attempts, budget, Retry-After and abort.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpError, isRetryableError, isRetryableStatus, retry } from "@/lib/net/retry";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const transient = () => Object.assign(new Error("reset"), { code: "ECONNRESET" });

describe("isRetryableStatus", () => {
  it.each([408, 425, 429, 500, 502, 503, 504, 599])("retries %i", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([200, 301, 400, 401, 403, 404, 409, 422, 501])("doesn't retry %i", (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

describe("isRetryableError", () => {
  it("retries network and undici codes", () => {
    for (const code of ["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET"]) {
      expect(isRetryableError(Object.assign(new Error("x"), { code }))).toBe(true);
    }
  });

  it("unwraps fetch's TypeError to its cause", () => {
    expect(isRetryableError(new TypeError("fetch failed", { cause: transient() }))).toBe(true);
  });

  it("retries a request timeout", () => {
    expect(isRetryableError(new DOMException("timed out", "TimeoutError"))).toBe(true);
  });

  it("reads status from every common shape", () => {
    expect(isRetryableError(new HttpError(503))).toBe(true);
    expect(isRetryableError({ statusCode: 429 })).toBe(true);
    expect(isRetryableError({ $metadata: { httpStatusCode: 500 } })).toBe(true);
    expect(isRetryableError({ response: { status: 502 } })).toBe(true);
    expect(isRetryableError(new HttpError(404))).toBe(false);
  });

  it("treats an explicit 4xx as final over a transient cause", () => {
    expect(isRetryableError(Object.assign(new HttpError(403), { cause: transient() }))).toBe(false);
  });

  it("doesn't retry NXDOMAIN, plain errors or non-errors", () => {
    expect(isRetryableError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(false);
    expect(isRetryableError(new Error("bad input"))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError("ECONNRESET")).toBe(false);
  });
});

describe("retry", () => {
  it("returns the first success", async () => {
    const fn = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("ok");
    const pending = retry(fn, { random: () => 0 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls.map((c) => c[0].attempt)).toEqual([1, 2]);
  });

  it("throws a non-transient error without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(400));
    await expect(retry(fn)).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops at maxAttempts and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(transient());
    const pending = retry(fn, { maxAttempts: 4 }).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ code: "ECONNRESET" });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("reports each retry with its delay", async () => {
    const onRetry = vi.fn();
    const pending = retry(vi.fn().mockRejectedValue(transient()), {
      maxAttempts: 3,
      baseMs: 100,
      jitter: "none",
      onRetry,
    }).catch(() => {});
    await vi.runAllTimersAsync();
    await pending;
    expect(onRetry.mock.calls.map((c) => [c[0].attempt, c[0].delayMs])).toEqual([
      [1, 100],
      [2, 200],
    ]);
  });

  it("maps the final error through onGiveUp", async () => {
    const pending = retry(vi.fn().mockRejectedValue(transient()), {
      maxAttempts: 2,
      onGiveUp: (err, info) => new Error(`gave up after ${info.attempts} (${info.retried})`, { cause: err }),
    }).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect(((await pending) as Error).message).toBe("gave up after 2 (true)");
  });

  it("gives up when the next wait would overrun the budget", async () => {
    const fn = vi.fn().mockRejectedValue(transient());
    const pending = retry(fn, { maxAttempts: 10, baseMs: 1_000, jitter: "none", budgetMs: 2_500 }).catch((e) => e);
    await vi.runAllTimersAsync();
    await pending;
    // Waits 1s then 2s would reach 3s, past the budget.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("waits at least the server's Retry-After, capped", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(429, "slow down", 5_000))
      .mockRejectedValueOnce(new HttpError(503, "busy", 10 * 60_000))
      .mockResolvedValue("ok");
    await expect(retry(fn, { maxAttempts: 3, baseMs: 100, maxRetryAfterMs: 60_000, sleep })).resolves.toBe("ok");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 60_000]);
  });

  it("reads Retry-After from a response", async () => {
    const response = new Response(null, { status: 429, headers: { "retry-after": "3" } });
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValueOnce(HttpError.fromResponse(response)).mockResolvedValue("ok");
    await retry(fn, { baseMs: 1, sleep });
    expect(sleep).toHaveBeenCalledWith(3_000, undefined);
  });

  it("stops waiting the moment the signal aborts", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(transient());
    const pending = retry(fn, { maxAttempts: 5, baseMs: 60_000, jitter: "none", signal: controller.signal }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error("shutdown"));
    expect(((await pending) as Error).message).toBe("shutdown");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never starts on an aborted signal", async () => {
    const fn = vi.fn();
    await expect(retry(fn, { signal: AbortSignal.abort(new Error("gone")) })).rejects.toThrow("gone");
    expect(fn).not.toHaveBeenCalled();
  });

  it("passes the signal to each attempt", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockResolvedValue(1);
    await retry(fn, { signal: controller.signal });
    expect(fn.mock.calls[0][0].signal).toBe(controller.signal);
  });
});
