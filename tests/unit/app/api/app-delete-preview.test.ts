// GET /api/v1/organizations/[orgId]/apps/[appId]/delete-preview
//
// Names come back without waiting on Docker's volume df; sizes are a second,
// bounded request.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, appsFindFirst, getVolumeSizesMock } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  appsFindFirst: vi.fn(),
  getVolumeSizesMock: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirst, findMany: vi.fn().mockResolvedValue([{ name: "api" }]) },
      environments: { findMany: vi.fn().mockResolvedValue([{ name: "production" }]) },
    },
  },
}));
vi.mock("@/lib/docker/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/client")>("@/lib/docker/client");
  return {
    ...actual,
    listVolumes: vi.fn().mockResolvedValue([
      { name: "api-production_pgdata", labels: {}, mountpoint: "" },
    ]),
    getVolumeSizes: getVolumeSizesMock,
  };
});

const { GET } = await import(
  "@/app/api/v1/organizations/[orgId]/apps/[appId]/delete-preview/route"
);
const { VOLUME_SIZES_TIMEOUT_MS } = await import("@/lib/docker/app-data");

const params = { params: Promise.resolve({ orgId: "org-1", appId: "app-1" }) };
const get = (query = "") =>
  GET(new NextRequest(`http://localhost/api/v1/organizations/org-1/apps/app-1/delete-preview${query}`), params);

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({ membership: { role: "owner" } });
  appsFindFirst.mockResolvedValue({ id: "app-1", name: "api", parentAppId: null, project: null });
  getVolumeSizesMock.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("delete preview", () => {
  it("lists volume names without asking Docker for sizes", async () => {
    const res = await get();
    const body = await res.json();

    expect(body.volumes).toEqual([{ name: "api-production_pgdata", sizeBytes: null }]);
    expect(getVolumeSizesMock).not.toHaveBeenCalled();
  });

  it("gives up on sizes once the bound passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled = false;
    const pending = get("?sizes=1").finally(() => (settled = true));
    // The filesystem scan runs on real I/O, so the bound's timer starts late.
    for (let waited = 0; !settled && waited < 50; waited++) {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(VOLUME_SIZES_TIMEOUT_MS);
    }
    const body = await (await pending).json();

    expect(body.volumes).toEqual([{ name: "api-production_pgdata", sizeBytes: null }]);
  });

  it("fills in sizes Docker reports in time", async () => {
    getVolumeSizesMock.mockResolvedValue(new Map([["api-production_pgdata", 2048]]));
    const body = await (await get("?sizes=1")).json();

    expect(body.volumes).toEqual([{ name: "api-production_pgdata", sizeBytes: 2048 }]);
  });
});
