// GET apps/[appId]/events replays a whole history batch without dropping events the client hasn't read yet.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, mockReadStream } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockReadStream: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/stream/consumer", () => ({ readStream: mockReadStream }));
vi.mock("@/lib/stream/keys", () => ({ eventStream: (id: string) => `events:${id}` }));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { GET } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/events/route");

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
});

describe("GET apps/[appId]/events — history replay", () => {
  it("delivers every entry of a multi-entry history", async () => {
    mockReadStream.mockReturnValue({
      // XRANGE hands over a whole batch; the generator never waits for the client.
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 30; i++) {
          const payload = JSON.stringify({ type: "deploy.status", appId: i % 3 === 0 ? "other" : "app-a", status: `s${i}` });
          yield { id: `1000-${i}`, fields: { payload } };
        }
      },
    });

    const res = await GET(new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-a/events"), params);
    // The client reads after the batch is replayed, as a slow connection would.
    await new Promise((r) => setTimeout(r, 20));
    const got = await readEvents(res, 20);

    expect(got).toHaveLength(20);
    expect(got.every((e) => e.startsWith("event: update"))).toBe(true);
  });
});
