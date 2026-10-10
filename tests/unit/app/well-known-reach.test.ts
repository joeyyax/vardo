import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { answerReachToken } = vi.hoisted(() => ({ answerReachToken: vi.fn() }));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/domains/reach", () => ({ answerReachToken }));

import { GET } from "@/app/.well-known/vardo/[token]/route";

const call = (token: string) =>
  (GET as unknown as (r: NextRequest, c: { params: Promise<{ token: string }> }) => Promise<Response>)(
    new NextRequest(`http://app.example.com/.well-known/vardo/${token}`),
    { params: Promise.resolve({ token }) },
  );

beforeEach(() => answerReachToken.mockReset());

describe("GET /.well-known/vardo/<token>", () => {
  it("answers a live token with its signature, uncached", async () => {
    answerReachToken.mockResolvedValue("f".repeat(64));
    const res = await call("t".repeat(32));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("f".repeat(64));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("404s an unknown token without echoing it", async () => {
    answerReachToken.mockResolvedValue(null);
    const res = await call("<b>hi</b>");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("hi");
  });
});
