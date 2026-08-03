// GET /api/v1/organizations/[orgId]/apps/[appId]/deploy/stream
//
// The app was verified but a caller-supplied `deploymentId` was streamed as
// given, so any app's build log — env var names, git URLs, image tags — was
// readable through an app the caller did own.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, appsFindFirst, deploymentsFindFirst, mockXlen, mockReadStream } =
  vi.hoisted(() => ({
    mockVerifyOrgAccess: vi.fn(),
    appsFindFirst: vi.fn(),
    deploymentsFindFirst: vi.fn(),
    mockXlen: vi.fn(),
    mockReadStream: vi.fn(),
  }));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/stream/consumer", () => ({ readStream: mockReadStream }));
vi.mock("@/lib/stream/keys", () => ({ deployStream: (id: string) => `deploy:${id}` }));
vi.mock("@/lib/redis", () => ({ redis: { xlen: mockXlen } }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirst },
      deployments: { findFirst: deploymentsFindFirst },
    },
  },
}));

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
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID } });
  appsFindFirst.mockResolvedValue({ id: APP_ID });
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
    deploymentsFindFirst.mockResolvedValue(undefined);

    const res = await GET(request("?deploymentId=deploy-other"), params);

    expect(res.status).toBe(404);
    expect(mockReadStream).not.toHaveBeenCalled();
  });

  it("does not fall back to the stored DB log for a foreign deployment", async () => {
    // Redis stream evicted, so the old code served deployments.log verbatim.
    mockXlen.mockResolvedValue(0);
    // The scoped ownership lookup misses; the unscoped log lookup would hit.
    deploymentsFindFirst.mockImplementation(
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
    deploymentsFindFirst.mockResolvedValue({ id: "deploy-1" });

    const res = await GET(request("?deploymentId=deploy-1"), params);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    vi.clearAllTimers();
  });

  it("still defaults to the app's latest deploy when no id is given", async () => {
    vi.useFakeTimers();
    deploymentsFindFirst.mockResolvedValue({ id: "deploy-latest", status: "running" });

    const res = await GET(request(), params);

    expect(res.status).toBe(200);
    // The default path resolves the deploy from the app, so no extra check runs.
    expect(deploymentsFindFirst).toHaveBeenCalledTimes(1);

    vi.clearAllTimers();
  });
});
