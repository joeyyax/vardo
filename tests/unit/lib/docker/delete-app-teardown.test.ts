// #892: deleteApp tears down leftovers by the app's id label and removes the emptied Auto job.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { order, findFirstMock, findManyMock, teardownMock, autoJobsMock } = vi.hoisted(() => ({
  order: [] as string[],
  findFirstMock: vi.fn(),
  findManyMock: vi.fn(),
  teardownMock: vi.fn(),
  autoJobsMock: vi.fn(),
}));

vi.mock("@/lib/metrics/series-cleanup", () => ({ deleteAppSeries: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/db", () => ({
  db: {
    query: { apps: { findFirst: findFirstMock, findMany: findManyMock } },
    delete: () => ({
      where: () => {
        order.push("delete-app-row");
        return { returning: async () => [] };
      },
    }),
  },
}));
vi.mock("@/lib/docker/deploy", () => ({ stopProject: async () => ({ success: true, log: "" }) }));
vi.mock("@/lib/docker/app-data", () => ({
  findAppData: async () => ({ volumes: [], bindMounts: [] }),
  appBindPaths: async () => [],
}));
vi.mock("@/lib/docker/client", () => ({ removeVolume: vi.fn(), stripDockerProjectPrefix: (n: string) => n }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/docker/app-dir-owner", () => ({
  assertAppDirOwnership: async () => {},
  removeAppDir: async () => {
    order.push("remove-dir");
    return { removed: true };
  },
}));
vi.mock("@/lib/docker/delete-teardown", () => ({ removeAppContainersAndNetworks: teardownMock }));
vi.mock("@/lib/backups/auto-backup", () => ({ deleteEmptyAutoJobs: autoJobsMock }));

import { deleteApp } from "@/lib/docker/delete-app";

beforeEach(() => {
  order.length = 0;
  findFirstMock.mockResolvedValue({ id: "app-1", name: "agents", projectId: null, parentAppId: null, isSystemManaged: false });
  findManyMock.mockResolvedValue([{ id: "child-1", name: "agents-db" }]);
  teardownMock.mockReset().mockImplementation(async () => {
    order.push("teardown");
    return { containers: [], networks: [], log: ["Removed container x"] };
  });
  autoJobsMock.mockReset().mockImplementation(async () => {
    order.push("auto-jobs");
    return ["job-1"];
  });
});

describe("deleteApp teardown", () => {
  it("removes containers by the app and child ids before the directory", async () => {
    const result = await deleteApp({ appId: "app-1", organizationId: "org-1" });

    expect(teardownMock).toHaveBeenCalledWith(["app-1", "child-1"]);
    expect(order.indexOf("teardown")).toBeLessThan(order.indexOf("remove-dir"));
    expect(result.log).toContain("Removed container x");
  });

  it("deletes the emptied Auto jobs for the app and its children after the rows go", async () => {
    await deleteApp({ appId: "app-1", organizationId: "org-1" });

    expect(autoJobsMock).toHaveBeenCalledWith("org-1", ["agents", "agents-db"]);
    expect(order.lastIndexOf("delete-app-row")).toBeLessThan(order.indexOf("auto-jobs"));
  });

  it("still deletes the app when the job cleanup throws", async () => {
    autoJobsMock.mockRejectedValue(new Error("db down"));

    await expect(deleteApp({ appId: "app-1", organizationId: "org-1" })).resolves.toMatchObject({ deleted: true });
  });
});
