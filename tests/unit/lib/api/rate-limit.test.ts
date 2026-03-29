import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// slidingWindowRateLimit — Redis sliding window, fail-open, retry-after
// ---------------------------------------------------------------------------
// Redis is mocked so these tests run without an actual Redis instance.

const { mockEval, mockZrange } = vi.hoisted(() => ({
  mockEval: vi.fn(),
  mockZrange: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    eval: mockEval,
    zrange: mockZrange,
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    child: () => ({ error: vi.fn() }),
  },
}));

import { slidingWindowRateLimit } from "@/lib/api/rate-limit";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("slidingWindowRateLimit", () => {
  describe("allowed requests", () => {
    it("returns { limited: false } when count is within limit", async () => {
      mockEval.mockResolvedValue(1); // count = 1, limit = 5
      const result = await slidingWindowRateLimit("user1:org1", "mcp:create-preview", 5, 60_000);
      expect(result).toEqual({ limited: false });
    });

    it("returns { limited: false } when count equals the limit exactly", async () => {
      mockEval.mockResolvedValue(5); // count = 5, limit = 5 — not strictly greater
      const result = await slidingWindowRateLimit("user1:org1", "mcp:create-preview", 5, 60_000);
      expect(result).toEqual({ limited: false });
    });
  });

  describe("rate-limited requests", () => {
    it("returns { limited: true } when count exceeds limit", async () => {
      mockEval.mockResolvedValue(6); // count = 6, limit = 5
      mockZrange.mockResolvedValue([]);
      const result = await slidingWindowRateLimit("user1:org1", "mcp:create-preview", 5, 60_000);
      expect(result).toMatchObject({ limited: true });
    });

    it("calculates retryAfterSeconds from oldest window entry", async () => {
      const now = Date.now();
      mockEval.mockResolvedValue(6);
      // Oldest entry was 10 seconds ago — 50s remain in a 60s window
      const oldestMs = now - 10_000;
      mockZrange.mockResolvedValue(["member", String(oldestMs)]);

      const result = await slidingWindowRateLimit("user1:org1", "mcp:create-preview", 5, 60_000);
      expect(result).toMatchObject({ limited: true });
      if (result.limited) {
        // ~50 seconds, allow ±2s for timing
        expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(48);
        expect(result.retryAfterSeconds).toBeLessThanOrEqual(52);
      }
    });

    it("falls back to ttl-based retry-after when zrange returns empty", async () => {
      mockEval.mockResolvedValue(6);
      mockZrange.mockResolvedValue([]);
      const result = await slidingWindowRateLimit("user1:org1", "mcp:create-preview", 5, 60_000);
      expect(result).toMatchObject({ limited: true, retryAfterSeconds: 60 });
    });
  });

  describe("Redis failure — fail-open", () => {
    it("returns { limited: false } when Redis eval throws", async () => {
      mockEval.mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await slidingWindowRateLimit("user1:org1", "mcp:create-preview", 5, 60_000);
      expect(result).toEqual({ limited: false });
    });

    it("still returns limited when zrange throws during retry-after calculation", async () => {
      mockEval.mockResolvedValue(6);
      mockZrange.mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await slidingWindowRateLimit("user1:org1", "mcp:create-preview", 5, 60_000);
      // zrange failure is best-effort — falls back to ttl
      expect(result).toMatchObject({ limited: true, retryAfterSeconds: 60 });
    });
  });

  describe("Redis key format", () => {
    it("builds key as rl:bucket:identifier when key is provided", async () => {
      mockEval.mockResolvedValue(1);
      await slidingWindowRateLimit("user:org", "mcp:create-preview", 5, 60_000);
      const calledKey = mockEval.mock.calls[0][2]; // third arg is the Redis key
      expect(calledKey).toBe("rl:mcp:create-preview:user:org");
    });

    it("builds key as rl:identifier when key is empty (legacy format)", async () => {
      mockEval.mockResolvedValue(1);
      await slidingWindowRateLimit("user:org", "", 5, 60_000);
      const calledKey = mockEval.mock.calls[0][2];
      expect(calledKey).toBe("rl:user:org");
    });
  });
});
