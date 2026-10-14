// GET apps/[appId]/deploy/stream replays a whole batch of log lines without dropping those the client hasn't read yet.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { NextRequest } from "next/server";
import type { TailHandlers } from "@/lib/stream/deploy-tail";

const { mockVerifyOrgAccess, mockTail } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockTail: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/stream/deploy-tail", () => ({ tailDeployment: mockTail }));
vi.mock("@/lib/stream/keys", () => ({ deployStream: (id: string) => `deploy:${id}` }));
vi.mock("@/lib/redis", () => ({ redis: { xlen: vi.fn(async () => 30) } }));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { GET } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/deploy/stream/route");

const params = { params: Promise.resolve({ orgId: "org-1", appId: "app-a" }) };

/** Reads SSE events until `count` arrive, then cancels the stream. */
async function readEvents(res: Response, count: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const events = () => text.split("\n\n").filter((b) => b.startsWith("event: "));
  const deadline = Date.now() + 2_000;
  while (events().length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return events();
}

beforeEach(() => {
  dbMock.reset();
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: "org-1" } });
  dbMock.query.apps.findFirst.mockResolvedValue({ id: "app-a" });
  dbMock.query.deployments.findFirst.mockResolvedValue({ id: "d1", status: "running" });
});

describe("GET deploy/stream — replay", () => {
  it("delivers every line of a replayed batch and the result", async () => {
    // The tail hands over the stream's backlog at once, without waiting for the client.
    mockTail.mockImplementation(async (_id: string, handlers: TailHandlers) => {
      for (let i = 0; i < 30; i++) handlers.onLog(`line ${i}`, { streamId: `1-${i}` });
      return { deploymentId: "d1", status: "success", success: true, durationMs: 1, log: "" };
    });

    const res = await GET(new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-a/deploy/stream?deploymentId=d1"), params);
    // The client reads after the batch is replayed, as a slow connection would.
    await new Promise((r) => setTimeout(r, 20));
    const got = await readEvents(res, 31);

    expect(got.filter((e) => e.startsWith("event: log"))).toHaveLength(30);
    expect(got.at(-1)).toMatch(/^event: done/);
  });
});
