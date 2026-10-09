import { describe, it, expect, vi, beforeEach } from "vitest";

const { client } = vi.hoisted(() => ({
  client: {
    getDfWithoutVolumes: vi.fn(),
    getDfVolumes: vi.fn(),
  },
}));

vi.mock("@/lib/docker/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/client")>("@/lib/docker/client");
  return { ...actual, ...client };
});

const { getDiskSnapshot, resetDiskSnapshotCache, VOLUME_REFRESH_MS } = await import("@/lib/docker/disk-snapshot");

beforeEach(() => {
  vi.clearAllMocks();
  resetDiskSnapshotCache();
  client.getDfWithoutVolumes.mockResolvedValue({ LayersSize: 100, Images: [], Containers: [], BuildCache: [] });
  client.getDfVolumes.mockResolvedValue({ Volumes: [{ Name: "a_data", UsageData: { Size: 7, RefCount: 1 }, Labels: {} }] });
});

describe("getDiskSnapshot", () => {
  it("walks volumes once per refresh window, not once per call", async () => {
    const first = await getDiskSnapshot(0);
    await getDiskSnapshot(5 * 60_000);
    expect(client.getDfWithoutVolumes).toHaveBeenCalledTimes(2);
    expect(client.getDfVolumes).toHaveBeenCalledTimes(1);
    expect(first.usage.volumes.totalSize).toBe(7);

    await getDiskSnapshot(VOLUME_REFRESH_MS + 1);
    expect(client.getDfVolumes).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last volume sizes when a refresh fails", async () => {
    await getDiskSnapshot(0);
    client.getDfVolumes.mockRejectedValue(new Error("timeout"));
    const snap = await getDiskSnapshot(VOLUME_REFRESH_MS + 1);
    expect(snap.usage.volumes.totalSize).toBe(7);
  });

  it("fails when volumes have never been measured", async () => {
    client.getDfVolumes.mockRejectedValue(new Error("timeout"));
    await expect(getDiskSnapshot(0)).rejects.toThrow("timeout");
  });
});
