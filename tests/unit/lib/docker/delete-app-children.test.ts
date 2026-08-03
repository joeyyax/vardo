import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  findFirstMock,
  findManyMock,
  deleteMock,
  deleteWhereMock,
  stopProjectMock,
  recordActivityMock,
} = vi.hoisted(() => {
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  return {
    findFirstMock: vi.fn(),
    findManyMock: vi.fn().mockResolvedValue([]),
    deleteMock: vi.fn(() => ({ where: deleteWhere })),
    deleteWhereMock: deleteWhere,
    stopProjectMock: vi.fn().mockResolvedValue({ success: true, log: "" }),
    recordActivityMock: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: findFirstMock, findMany: findManyMock },
      volumes: { findMany: vi.fn().mockResolvedValue([]) },
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
vi.mock("@/lib/activity", () => ({ recordActivity: recordActivityMock }));
vi.mock("@/lib/docker/app-dir-owner", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/app-dir-owner")>(
    "@/lib/docker/app-dir-owner",
  );
  return { ...actual, assertAppDirOwnership: vi.fn().mockResolvedValue(undefined) };
});

import { deleteApp } from "@/lib/docker/delete-app";

const PARENT = {
  id: "app-parent",
  name: "glitchtip",
  projectId: null,
  parentAppId: null,
  isSystemManaged: false,
  persistentVolumes: [],
};

const CHILDREN = ["postgres", "redis", "web", "worker"].map((s) => ({
  id: `child-${s}`,
  name: `glitchtip-${s}`,
  persistentVolumes: [],
}));

beforeEach(() => {
  vi.clearAllMocks();
  findFirstMock.mockResolvedValue(PARENT);
  findManyMock.mockResolvedValue(CHILDREN);
  stopProjectMock.mockResolvedValue({ success: true, log: "" });
});

describe("deleting a parent compose app", () => {
  it("removes its children", async () => {
    const result = await deleteApp({ appId: "app-parent", organizationId: "org-1" });

    expect(result.removedChildApps).toEqual([
      "glitchtip-postgres",
      "glitchtip-redis",
      "glitchtip-web",
      "glitchtip-worker",
    ]);
    expect(deleteWhereMock).toHaveBeenCalledTimes(2);
  });

  it("reports the removed services in the audit trail", async () => {
    await deleteApp({ appId: "app-parent", organizationId: "org-1" });

    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "app.deleted",
        metadata: expect.objectContaining({ removedChildApps: CHILDREN.map((c) => c.name) }),
      })
    );
  });

  it("issues no child delete when the stack has no services", async () => {
    findManyMock.mockResolvedValue([]);

    const result = await deleteApp({ appId: "app-parent", organizationId: "org-1" });

    expect(result.removedChildApps).toEqual([]);
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
  });
});

describe("deleting a compose child on its own", () => {
  const CHILD = {
    id: "child-web",
    name: "glitchtip-web",
    projectId: null,
    parentAppId: "app-parent",
    isSystemManaged: false,
    persistentVolumes: [],
  };

  beforeEach(() => {
    findFirstMock.mockResolvedValueOnce(CHILD).mockResolvedValueOnce({ name: "glitchtip" });
  });

  it("is refused, so a service can't be stranded from its stack", async () => {
    await expect(
      deleteApp({ appId: "child-web", organizationId: "org-1" })
    ).rejects.toThrow(/compose stack/);

    expect(deleteWhereMock).not.toHaveBeenCalled();
    expect(stopProjectMock).not.toHaveBeenCalled();
  });

  it("is allowed through the explicit escape hatch", async () => {
    const result = await deleteApp({
      appId: "child-web",
      organizationId: "org-1",
      allowChildDelete: true,
    });

    expect(result.deleted).toBe(true);
  });
});
