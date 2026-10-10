import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ redis: { get: vi.fn(), set: vi.fn(), mget: vi.fn() } }));
vi.mock("@/lib/docker/client", () => ({
  inspectContainer: vi.fn(),
  inspectImageMeta: vi.fn(),
  listContainers: vi.fn(),
}));

import { BASE_IMAGE_LABEL, coveredDataPath, detectStateful, verdictByName } from "@/lib/docker/image-updates/stateful-detect";
import { probeServiceStateful, serviceVerdictKey, type ProbeDeps } from "@/lib/docker/image-updates/stateful-probe";
import { defaultTrackMode } from "@/lib/docker/image-updates/track-policy";

const PG_DATA = "/var/lib/postgresql/data";

describe("coveredDataPath", () => {
  it("matches a mount at or above the image volume", () => {
    expect(coveredDataPath([PG_DATA], [PG_DATA])).toBe(PG_DATA);
    expect(coveredDataPath([PG_DATA], ["/var/lib/postgresql/"])).toBe(PG_DATA);
    expect(coveredDataPath(["/data"], ["/"])).toBe("/data");
  });

  it("ignores a mount below or beside the volume", () => {
    expect(coveredDataPath([PG_DATA], [`${PG_DATA}/pg_wal`])).toBeNull();
    expect(coveredDataPath(["/data"], ["/data2"])).toBeNull();
    expect(coveredDataPath([], [PG_DATA])).toBeNull();
  });
});

describe("detectStateful", () => {
  it("detects a renamed postgres image from its volume and PG_VERSION", () => {
    const verdict = detectStateful({ image: "acme/db:16", imageVolumes: [PG_DATA], mounts: [PG_DATA], stamps: ["PG_VERSION"] });
    expect(verdict).toMatchObject({
      ownsData: true,
      majorLocked: true,
      source: "behavior",
      dataPath: PG_DATA,
      stamp: "PG_VERSION",
      reason: `stores data in ${PG_DATA}`,
    });
    expect(defaultTrackMode("acme/db:16", verdict)).toBe("major");
  });

  it("owns data without a major lock when no stamp is found", () => {
    const verdict = detectStateful({ image: "acme/uploads:3", imageVolumes: ["/srv/files"], mounts: ["/srv"] });
    expect(verdict).toMatchObject({ ownsData: true, majorLocked: false, source: "behavior", stamp: null });
  });

  it("needs a persistent mount, not only a declared VOLUME", () => {
    const verdict = detectStateful({ image: "acme/cache:1", imageVolumes: ["/data"], mounts: [] });
    expect(verdict).toMatchObject({ ownsData: false, source: "none" });
    expect(defaultTrackMode("acme/cache:1", verdict)).toBe("latest");
  });

  it("reads the base-image label when there is no mounted volume", () => {
    const verdict = detectStateful({
      image: "acme/db:16",
      imageVolumes: [],
      mounts: [],
      labels: { [BASE_IMAGE_LABEL]: "docker.io/library/postgres:16" },
    });
    expect(verdict).toMatchObject({ ownsData: true, majorLocked: true, source: "base-image", reason: "built on docker.io/library/postgres:16" });
  });

  it("falls back to the name lists", () => {
    expect(verdictByName("postgres:16")).toMatchObject({ ownsData: true, majorLocked: true, source: "name" });
    expect(verdictByName("redis:7")).toMatchObject({ ownsData: true, majorLocked: false, source: "name" });
    expect(verdictByName("ghost:5")).toMatchObject({ ownsData: false, source: "none" });
  });
});

function deps(overrides: Partial<ProbeDeps> = {}) {
  const store = new Map<string, string>();
  const base: ProbeDeps = {
    findContainer: vi.fn(async () => ({ id: "c1", image: "acme/db:16" })),
    mounts: vi.fn(async () => [PG_DATA]),
    imageMeta: vi.fn(async () => ({ id: "sha256:abc", volumes: [PG_DATA], labels: {} })),
    stamps: vi.fn(async () => ["PG_VERSION"]),
    cache: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    },
  };
  return { ...base, ...overrides, store };
}

describe("probeServiceStateful", () => {
  it("probes a running service and stores the verdict per service", async () => {
    const d = deps();
    const verdict = await probeServiceStateful({ id: "app-1", name: "blog" }, "db", d);
    expect(verdict).toMatchObject({ majorLocked: true, stamp: "PG_VERSION", imageId: "sha256:abc" });
    expect(d.stamps).toHaveBeenCalledWith("c1", PG_DATA);
    expect(JSON.parse(d.store.get(serviceVerdictKey("app-1", "db"))!)).toMatchObject({ dataPath: PG_DATA });
  });

  it("reuses the verdict cached for the same image digest", async () => {
    const d = deps();
    await probeServiceStateful({ id: "app-1", name: "blog" }, "db", d);
    await probeServiceStateful({ id: "app-2", name: "shop" }, "db", d);
    expect(d.stamps).toHaveBeenCalledTimes(1);
    expect(d.store.has(serviceVerdictKey("app-2", "db"))).toBe(true);
  });

  it("probes again for a new digest", async () => {
    const d = deps();
    await probeServiceStateful({ id: "app-1", name: "blog" }, "db", d);
    d.imageMeta = vi.fn(async () => ({ id: "sha256:def", volumes: [PG_DATA], labels: {} }));
    await probeServiceStateful({ id: "app-1", name: "blog" }, "db", d);
    expect(d.stamps).toHaveBeenCalledTimes(2);
  });

  it("skips the stamp read without a covered data path", async () => {
    const d = deps({ mounts: vi.fn(async () => []) });
    const verdict = await probeServiceStateful({ id: "app-1", name: "blog" }, "db", d);
    expect(d.stamps).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ ownsData: false, source: "none" });
  });

  it("returns null with nothing running", async () => {
    const d = deps({ findContainer: vi.fn(async () => null) });
    expect(await probeServiceStateful({ id: "app-1", name: "blog" }, "db", d)).toBeNull();
    expect(d.store.size).toBe(0);
  });
});
