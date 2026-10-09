import { describe, it, expect } from "vitest";
import { parseBuildKitDu, parseBuildKitPrune } from "@/lib/docker/buildkit";

// Shapes from `buildctl du|prune --format '{{json .}}'` on moby/buildkit:v0.34.0.
describe("BuildKit cache parsing", () => {
  it("sums du records and counts only idle, unshared ones as reclaimable", () => {
    const du = JSON.stringify([
      { id: "a", size: 1000, inUse: false, shared: false },
      { id: "b", size: 500, inUse: true, shared: false },
      { id: "c", size: 200, inUse: false, shared: true },
      { id: "d", size: 0, inUse: false, shared: false },
    ]);
    expect(parseBuildKitDu(du)).toEqual({ totalSize: 1700, reclaimable: 1000 });
  });

  it("reads an empty cache", () => {
    expect(parseBuildKitDu("null\n")).toEqual({ totalSize: 0, reclaimable: 0 });
    expect(parseBuildKitDu("")).toEqual({ totalSize: 0, reclaimable: 0 });
  });

  it("sums prune output, one record per line", () => {
    const out = '{"id":"a","size":4096}\n{"id":"b","size":6140000}\n\n';
    expect(parseBuildKitPrune(out)).toBe(6144096);
  });
});
