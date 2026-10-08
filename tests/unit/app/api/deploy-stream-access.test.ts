// GET /api/v1/organizations/[orgId]/apps/[appId]/deploy/stream
//
// The app was verified but a caller-supplied `deploymentId` was streamed as
// given, so any app's build log — env var names, git URLs, image tags — was
// readable through an app the caller did own.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, mockXlen, mockReadStream } =
  vi.hoisted(() => ({
    mockVerifyOrgAccess: vi.fn(),
    mockXlen: vi.fn(),
    mockReadStream: vi.fn(),
  }));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/stream/consumer", () => ({ readStream: mockReadStream }));
vi.mock("@/lib/stream/keys", () => ({ deployStream: (id: string) => `deploy:${id}` }));
vi.mock("@/lib/redis", () => ({ redis: { xlen: mockXlen } }));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { GET } = await import(
  "@/app/api/v1/organizations/[orgId]/apps/[appId]/deploy/stream/route"
);

const ORG_ID = "org-1";
const APP_ID = "app-a";
const params = { params: Promise.resolve({ orgId: ORG_ID, appId: APP_ID }) };

function request(query = "") {
  return new NextRequest(
    `http://localhost/api/v1/organizations/${ORG_ID}/apps/${APP_ID}/deploy/stream${query}`,
  );
}

beforeEach(() => {
  dbMock.reset();
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID } });
  dbMock.query.apps.findFirst.mockResolvedValue({ id: APP_ID });
  mockXlen.mockResolvedValue(5);
  mockReadStream.mockReturnValue({
    async *[Symbol.asyncIterator]() {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET deploy/stream — deployment ownership", () => {
  it("rejects a deploymentId belonging to another app", async () => {
    // Scoped lookup finds nothing — the deploy is not this app's.
    dbMock.query.deployments.findFirst.mockResolvedValue(undefined);

    const res = await GET(request("?deploymentId=deploy-other"), params);

    expect(res.status).toBe(404);
    expect(mockReadStream).not.toHaveBeenCalled();
  });

  it("does not fall back to the stored DB log for a foreign deployment", async () => {
    // Redis stream evicted, so the old code served deployments.log verbatim.
    mockXlen.mockResolvedValue(0);
    // The scoped ownership lookup misses; the unscoped log lookup would hit.
    dbMock.query.deployments.findFirst.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (query: any) =>
        query?.columns?.log
          ? { id: "deploy-other", status: "success", log: "DATABASE_URL=redacted" }
          : undefined,
    );

    const res = await GET(request("?deploymentId=deploy-other"), params);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("DATABASE_URL");
  });

  it("streams a deploymentId that belongs to the app", async () => {
    vi.useFakeTimers();
    dbMock.query.deployments.findFirst.mockResolvedValue({ id: "deploy-1" });

    const res = await GET(request("?deploymentId=deploy-1"), params);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    vi.clearAllTimers();
  });

  it("still defaults to the app's latest deploy when no id is given", async () => {
    vi.useFakeTimers();
    dbMock.query.deployments.findFirst.mockResolvedValue({ id: "deploy-latest", status: "running" });

    const res = await GET(request(), params);

    expect(res.status).toBe(200);
    // The default path resolves the deploy from the app, so no extra check runs.
    expect(dbMock.query.deployments.findFirst).toHaveBeenCalledTimes(1);

    vi.clearAllTimers();
  });
});
