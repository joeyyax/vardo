import { beforeEach, describe, expect, it, vi } from "vitest";

type RemoveResult = { untagged: string[]; deleted: string[] };

const client = vi.hoisted(() => ({
  removeImage:
    vi.fn<(nameOrId: string, opts?: { force?: boolean }) => Promise<RemoveResult>>(),
  removeVolume: vi.fn(),
  listVolumes: vi.fn(),
  pruneImages: vi.fn(),
  pruneBuildCache: vi.fn(),
  removeContainer: vi.fn(),
}));

vi.mock("@/lib/docker/client", () => client);

const { executeReclaimPlan } = await import("@/lib/docker/image-reclaim/run");
type ReclaimPlan = import("@/lib/docker/image-reclaim/plan").ReclaimPlan;

function makePlan(): ReclaimPlan {
  return {
    defaultIdleDays: 30,
    generatedAt: "2026-08-02T00:00:00.000Z",
    estimatedBytes: 3_000,
    skipped: [],
    candidates: [
      {
        appId: "app_1",
        appName: "jellyfin",
        displayName: "Jellyfin",
        idleDays: 200,
        thresholdDays: 30,
        estimatedBytes: 3_000,
        images: [
          { image: "jellyfin/jellyfin:10.9.11", safety: "pinned", bytes: 1_000, present: true },
          { image: "ghcr.io/absent/thing:1.2.3", safety: "pinned", bytes: 500, present: false },
          { image: "nginx:1.27", safety: "pinned", bytes: 2_000, present: true },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.removeImage.mockResolvedValue({ untagged: ["x"], deleted: ["sha256:x"] });
});

describe("executeReclaimPlan — volumes are never touched", () => {
  it("calls no volume or container API, only image removal", async () => {
    await executeReclaimPlan(makePlan(), { dryRun: false });

    expect(client.removeImage).toHaveBeenCalled();
    expect(client.removeVolume).not.toHaveBeenCalled();
    expect(client.listVolumes).not.toHaveBeenCalled();
    expect(client.removeContainer).not.toHaveBeenCalled();
    expect(client.pruneImages).not.toHaveBeenCalled();
    expect(client.pruneBuildCache).not.toHaveBeenCalled();
  });

  it("never forces removal — forcing only untags and frees nothing", async () => {
    await executeReclaimPlan(makePlan(), { dryRun: false });
    for (const call of client.removeImage.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });
});

describe("executeReclaimPlan — a dry run and a real run agree", () => {
  it("targets exactly the same images", async () => {
    const plan = makePlan();

    const dry = await executeReclaimPlan(plan, { dryRun: true });
    expect(client.removeImage).not.toHaveBeenCalled();

    const real = await executeReclaimPlan(plan, { dryRun: false });

    expect(dry.reclaimed.map((r) => r.image)).toEqual(real.reclaimed.map((r) => r.image));
    expect(dry.appsAffected).toBe(real.appsAffected);
    expect(dry.estimatedBytesFreed).toBe(real.estimatedBytesFreed);
    expect(client.removeImage.mock.calls.map((c) => c[0])).toEqual(dry.reclaimed.map((r) => r.image));
  });

  it("skips images that are not present locally in both modes", async () => {
    const dry = await executeReclaimPlan(makePlan(), { dryRun: true });
    expect(dry.reclaimed.map((r) => r.image)).not.toContain("ghcr.io/absent/thing:1.2.3");

    await executeReclaimPlan(makePlan(), { dryRun: false });
    expect(client.removeImage).toHaveBeenCalledTimes(2);
  });
});

describe("executeReclaimPlan — reporting", () => {
  it("does not count an untag-only removal as freed space", async () => {
    client.removeImage.mockResolvedValue({ untagged: ["x"], deleted: [] });
    const result = await executeReclaimPlan(makePlan(), { dryRun: false });

    expect(result.reclaimed).toHaveLength(2);
    expect(result.reclaimed.every((r) => r.freedLayers === false)).toBe(true);
    expect(result.estimatedBytesFreed).toBe(0);
  });

  it("reports a still-referenced image as a failure, not a success", async () => {
    client.removeImage.mockRejectedValue(new Error("409 Conflict: image is being used"));
    const result = await executeReclaimPlan(makePlan(), { dryRun: false });

    expect(result.reclaimed).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].error).toBe("Still referenced by a container");
  });

  it("keeps going after one image fails", async () => {
    client.removeImage
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ untagged: ["x"], deleted: ["sha256:x"] });

    const result = await executeReclaimPlan(makePlan(), { dryRun: false });
    expect(result.failed).toHaveLength(1);
    expect(result.reclaimed).toHaveLength(1);
    expect(result.estimatedBytesFreed).toBe(2_000);
  });

  it("does nothing at all for an empty plan", async () => {
    const empty: ReclaimPlan = { ...makePlan(), candidates: [], estimatedBytes: 0 };
    const result = await executeReclaimPlan(empty, { dryRun: false });

    expect(client.removeImage).not.toHaveBeenCalled();
    expect(result.reclaimed).toHaveLength(0);
    expect(result.appsAffected).toBe(0);
  });
});
