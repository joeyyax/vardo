import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  findFirstMock,
  findManyMock,
  volumesFindManyMock,
  deleteMock,
  deleteWhereMock,
  stopProjectMock,
  assertOwnershipMock,
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
vi.mock("@/lib/docker/client", () => ({
  listVolumes: vi.fn().mockResolvedValue([]),
  removeVolume: vi.fn(),
  stripDockerProjectPrefix: (n: string) => n,
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/docker/app-dir-owner", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/app-dir-owner")>(
    "@/lib/docker/app-dir-owner",
  );
  return { ...actual, assertAppDirOwnership: assertOwnershipMock };
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
});

describe("deleteApp ownership guard", () => {
  it("aborts before stopping containers or deleting the row", async () => {
    assertOwnershipMock.mockRejectedValue(
      new AppDirOwnershipError("Refusing to delete \"api\"", "app-1", "api"),
    );

    await expect(
      deleteApp({ appId: "app-1", organizationId: "org-1", pruneVolumes: true }),
    ).rejects.toThrow(AppDirOwnershipError);

    expect(stopProjectMock).not.toHaveBeenCalled();
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
