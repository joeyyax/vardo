import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  findFirstMock,
  findManyMock,
  volumesFindManyMock,
  deleteMock,
  deleteWhereMock,
  stopProjectMock,
  assertOwnershipMock,
  removeAppDirMock,
  appBindPathsMock,
} = vi.hoisted(() => {
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  return {
    findFirstMock: vi.fn(),
    findManyMock: vi.fn().mockResolvedValue([]),
    volumesFindManyMock: vi.fn().mockResolvedValue([]),
    deleteMock: vi.fn(() => ({ where: deleteWhere })),
    deleteWhereMock: deleteWhere,
    stopProjectMock: vi.fn().mockResolvedValue({ success: true, log: "" }),
    assertOwnershipMock: vi.fn().mockResolvedValue(undefined),
    removeAppDirMock: vi.fn().mockResolvedValue({ removed: true }),
    appBindPathsMock: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: findFirstMock, findMany: findManyMock },
      volumes: { findMany: volumesFindManyMock },
    },
    delete: deleteMock,
  },
}));
vi.mock("@/lib/docker/deploy", () => ({ stopProject: stopProjectMock }));
vi.mock("@/lib/docker/app-data", () => ({
  findAppData: vi.fn().mockResolvedValue({ volumes: [], bindMounts: [] }),
  appBindPaths: appBindPathsMock,
}));
vi.mock("@/lib/docker/client", () => ({
  listVolumes: vi.fn().mockResolvedValue([]),
  removeVolume: vi.fn(),
  stripDockerProjectPrefix: (n: string) => n,
}));
vi.mock("@/lib/docker/delete-teardown", () => ({
  removeAppContainersAndNetworks: vi.fn().mockResolvedValue({ containers: [], networks: [], log: [] }),
  claimAppDirTopLevel: vi.fn(),
  isPermissionError: () => false,
}));
vi.mock("@/lib/backups/auto-backup", () => ({ deleteEmptyAutoJobs: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/docker/app-dir-owner", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/app-dir-owner")>(
    "@/lib/docker/app-dir-owner",
  );
  return {
    ...actual,
    assertAppDirOwnership: assertOwnershipMock,
    removeAppDir: removeAppDirMock,
  };
});

import { deleteApp } from "@/lib/docker/delete-app";
import { AppDirOwnershipError } from "@/lib/docker/app-dir-owner";

const APP = {
  id: "app-1",
  name: "api",
  projectId: null,
  parentAppId: null,
  isSystemManaged: false,
  persistentVolumes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirstMock.mockResolvedValue(APP);
  findManyMock.mockResolvedValue([]);
  stopProjectMock.mockResolvedValue({ success: true, log: "" });
  assertOwnershipMock.mockResolvedValue(undefined);
  removeAppDirMock.mockResolvedValue({ removed: true });
  appBindPathsMock.mockResolvedValue([]);
});

describe("deleteApp ownership guard", () => {
  it("aborts before stopping containers or deleting the row", async () => {
    assertOwnershipMock.mockRejectedValue(
      new AppDirOwnershipError("Refusing to delete \"api\"", "app-1", "api"),
    );

    await expect(
      deleteApp({ appId: "app-1", organizationId: "org-1", deleteVolumes: true }),
    ).rejects.toThrow(AppDirOwnershipError);

    expect(stopProjectMock).not.toHaveBeenCalled();
    expect(removeAppDirMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it("deletes normally when the directory belongs to the app", async () => {
    const result = await deleteApp({ appId: "app-1", organizationId: "org-1" });

    expect(assertOwnershipMock).toHaveBeenCalledWith({
      appId: "app-1",
      appName: "api",
      operation: "delete",
    });
    expect(stopProjectMock).toHaveBeenCalled();
    expect(result.deleted).toBe(true);
  });
});

describe("deleteApp directory removal", () => {
  it("removes the app directory before the row is deleted", async () => {
    const result = await deleteApp({ appId: "app-1", organizationId: "org-1" });

    expect(removeAppDirMock).toHaveBeenCalledWith({ appId: "app-1", appName: "api", keep: [] });
    expect(removeAppDirMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMock.mock.invocationCallOrder[0],
    );
    expect(result.removedAppDir).toBe(true);
  });

  it("still deletes the app when the directory cannot be removed", async () => {
    removeAppDirMock.mockResolvedValue({
      removed: false,
      reason: "EACCES: permission denied",
    });

    const result = await deleteApp({ appId: "app-1", organizationId: "org-1" });

    expect(result.deleted).toBe(true);
    expect(result.removedAppDir).toBe(false);
    expect(result.log).toContain("EACCES: permission denied");
    expect(deleteWhereMock).toHaveBeenCalled();
  });

  it("leaves the directory alone when deleting a compose child", async () => {
    findFirstMock.mockResolvedValue({ ...APP, id: "child-1", parentAppId: "app-1" });

    const result = await deleteApp({
      appId: "child-1",
      organizationId: "org-1",
      allowChildDelete: true,
    });

    expect(removeAppDirMock).not.toHaveBeenCalled();
    expect(result.removedAppDir).toBe(false);
  });
});

describe("deleteApp bind-mounted data", () => {
  const DATA = "/apps/api/production/blue/uploads";

  it("keeps it by default", async () => {
    appBindPathsMock.mockResolvedValue([DATA]);
    await deleteApp({ appId: "app-1", organizationId: "org-1" });

    expect(removeAppDirMock).toHaveBeenCalledWith(expect.objectContaining({ keep: [DATA] }));
  });

  it("removes it with deleteVolumes", async () => {
    appBindPathsMock.mockResolvedValue([DATA]);
    await deleteApp({ appId: "app-1", organizationId: "org-1", deleteVolumes: true });

    expect(removeAppDirMock).toHaveBeenCalledWith(expect.objectContaining({ keep: [] }));
  });
});
