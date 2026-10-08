// DELETE /api/v1/organizations/[orgId]/apps/[appId]
//
// Volumes and bind-mounted data survive a delete unless the request says
// `deleteVolumes: true`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyOrgAccess,
  appsFindFirst,
  appsFindMany,
  envFindMany,
  stopProjectMock,
  removeVolumeMock,
  listVolumesMock,
  removeAppDirMock,
} = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  appsFindFirst: vi.fn(),
  appsFindMany: vi.fn(),
  envFindMany: vi.fn(),
  stopProjectMock: vi.fn(),
  removeVolumeMock: vi.fn(),
  listVolumesMock: vi.fn(),
  removeAppDirMock: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirst, findMany: appsFindMany },
      environments: { findMany: envFindMany },
    },
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  },
}));
vi.mock("@/lib/docker/deploy", () => ({ stopProject: stopProjectMock }));
vi.mock("@/lib/docker/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/client")>("@/lib/docker/client");
  return {
    ...actual,
    listVolumes: listVolumesMock,
    removeVolume: removeVolumeMock,
    getVolumeSizes: vi.fn().mockResolvedValue(new Map()),
  };
});
vi.mock("@/lib/docker/app-dir-owner", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/app-dir-owner")>(
    "@/lib/docker/app-dir-owner",
  );
  return {
    ...actual,
    assertAppDirOwnership: vi.fn().mockResolvedValue(undefined),
    removeAppDir: removeAppDirMock,
  };
});
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

const { DELETE } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/route");

const params = { params: Promise.resolve({ orgId: "org-1", appId: "app-1" }) };

const APP = {
  id: "app-1",
  name: "api",
  projectId: null,
  parentAppId: null,
  isSystemManaged: false,
};

function vol(name: string, project?: string): { name: string; labels: Record<string, string>; mountpoint: string } {
  return {
    name,
    labels: project ? { "com.docker.compose.project": project } : {},
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  };
}

function del(body?: unknown) {
  return new NextRequest("http://localhost/api/v1/organizations/org-1/apps/app-1", {
    method: "DELETE",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({
    membership: { role: "owner" },
    session: { user: { id: "user-1" } },
  });
  appsFindFirst.mockResolvedValue(APP);
  // Children lookup has a where; the name listing for collision checks doesn't.
  appsFindMany.mockImplementation((args: { where?: unknown }) =>
    Promise.resolve(args?.where ? [] : [{ name: "api" }, { name: "api-v2" }]),
  );
  envFindMany.mockResolvedValue([{ name: "production" }]);
  stopProjectMock.mockResolvedValue({ success: true, log: "" });
  removeVolumeMock.mockResolvedValue(undefined);
  removeAppDirMock.mockResolvedValue({ removed: true });
  listVolumesMock.mockResolvedValue([
    vol("api-production_pgdata"),
    vol("api-production-shared_redis", "api-production-shared"),
    vol("api-v2-production_pgdata"),
    vol("unrelated_data", "unrelated"),
  ]);
});

describe("deleting an app", () => {
  it("keeps every volume when the request doesn't ask", async () => {
    const res = await DELETE(del(), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(removeVolumeMock).not.toHaveBeenCalled();
    for (const call of stopProjectMock.mock.calls) expect(call[3]).not.toBe(true);
    expect(body.keptVolumes).toEqual(["api-production-shared_redis", "api-production_pgdata"]);
  });

  it("keeps them when deleteVolumes is false", async () => {
    await DELETE(del({ deleteVolumes: false }), params);

    expect(removeVolumeMock).not.toHaveBeenCalled();
  });

  it("destroys only the app's own volumes when deleteVolumes is true", async () => {
    const res = await DELETE(del({ deleteVolumes: true }), params);
    const body = await res.json();

    expect(removeVolumeMock.mock.calls.map((c) => c[0]).sort()).toEqual([
      "api-production-shared_redis",
      "api-production_pgdata",
    ]);
    expect(body.removedVolumes).toHaveLength(2);
    expect(removeAppDirMock).toHaveBeenCalledWith(expect.objectContaining({ keep: [] }));
  });

  it("refuses anything but a boolean", async () => {
    const res = await DELETE(del({ deleteVolumes: "yes" }), params);

    expect(res.status).toBe(400);
    expect(stopProjectMock).not.toHaveBeenCalled();
  });
});
