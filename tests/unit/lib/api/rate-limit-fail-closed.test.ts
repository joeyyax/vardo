// Without Redis, auth endpoints refuse requests; everything else stays open.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockEval } = vi.hoisted(() => ({ mockEval: vi.fn() }));

vi.mock("@/lib/redis", () => ({ redis: { eval: mockEval, zrange: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } }));

const { slidingWindowRateLimit } = await import("@/lib/api/rate-limit");
const { withRateLimit } = await import("@/lib/api/with-rate-limit");

const handler = vi.fn(async () => NextResponse.json({ ok: true }));
const request = () =>
  new NextRequest("http://localhost/api/auth/sign-in/email", { method: "POST", headers: { "x-forwarded-for": "203.0.113.7" } });

beforeEach(() => {
  vi.clearAllMocks();
  mockEval.mockRejectedValue(new Error("connect ECONNREFUSED"));
});

describe("rate limiting without Redis", () => {
  it("refuses auth requests with a 503", async () => {
    const res = await withRateLimit(handler, { tier: "auth" })(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets other tiers through", async () => {
    for (const tier of ["read", "mutation", "public"] as const) {
      const res = await withRateLimit(handler, { tier })(request());
      expect(res.status).toBe(200);
    }
  });

  it("fails open by default for direct callers", async () => {
    expect(await slidingWindowRateLimit("u:o", "mcp:x", 5, 60_000)).toEqual({ limited: false });
    expect(await slidingWindowRateLimit("u:o", "mcp:x", 5, 60_000, { failClosed: true })).toMatchObject({ limited: true, unavailable: true });
  });
});
