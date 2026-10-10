import { describe, it, expect, beforeEach, vi } from "vitest";

const { dockerRequestMock, selectRows, findFirstMock } = vi.hoisted(() => ({
  dockerRequestMock: vi.fn(),
  selectRows: { family: [] as { id: string }[], owners: [] as { name: string }[] },
  findFirstMock: vi.fn(),
}));

vi.mock("@/lib/docker/client", () => ({ dockerRequest: dockerRequestMock }));
vi.mock("@/lib/db", () => {
  // Family lookup ends in where(); the prefix lookup goes on to limit().
  const chain = () => {
    const where = vi.fn(() => {
      const rows = Promise.resolve(selectRows.family) as Promise<unknown> & { limit?: unknown };
      rows.limit = vi.fn(async () => selectRows.owners);
      return rows;
    });
    return { from: vi.fn(() => ({ where, leftJoin: vi.fn(() => ({ where })) })) };
  };
  return { db: { select: vi.fn(chain), query: { apps: { findFirst: findFirstMock } } } };
});

import { foreignVolumeHolders, volumeOwnerProblem, volumeProject } from "@/lib/docker/volume-owner";

describe("volume owner checks", () => {
  beforeEach(() => {
    dockerRequestMock.mockReset().mockResolvedValue([]);
    findFirstMock.mockReset().mockResolvedValue({ parentAppId: null });
    selectRows.family = [];
    selectRows.owners = [];
  });

  it("reads the compose project off a volume name", () => {
    expect(volumeProject("web-db-production_data")).toBe("web-db-production");
    expect(volumeProject("plain")).toBeNull();
  });

  it("names containers of another app that mount the volume", async () => {
    dockerRequestMock.mockResolvedValue([
      { Names: ["/mine"], Labels: { "vardo.project.id": "app-1" } },
      { Names: ["/helper"], Labels: {} },
      { Names: ["/theirs"], Labels: { "vardo.project.id": "app-9" } },
    ]);
    expect(await foreignVolumeHolders(["app-1"], "web-production_data")).toEqual(["theirs"]);
  });

  it("treats the parent and sibling services as the same app", async () => {
    findFirstMock.mockResolvedValue({ parentAppId: "parent" });
    selectRows.family = [{ id: "child-a" }, { id: "child-b" }];
    dockerRequestMock.mockResolvedValue([{ Names: ["/db"], Labels: { "vardo.project.id": "parent" } }]);
    expect(await volumeOwnerProblem("child-a", "web-production_data")).toBeNull();
  });

  it("refuses a volume another app's names derive", async () => {
    selectRows.owners = [{ name: "web-db" }];
    expect(await volumeOwnerProblem("app-1", "web-db-production_data")).toMatch(/another app \(web-db\)/);
  });

  it("refuses a volume another app's container mounts", async () => {
    dockerRequestMock.mockResolvedValue([{ Names: ["/victim-db"], Labels: { "vardo.project.id": "app-9" } }]);
    expect(await volumeOwnerProblem("app-1", "web-db-production_data")).toMatch(/mounted by another app \(victim-db\)/);
  });
});
