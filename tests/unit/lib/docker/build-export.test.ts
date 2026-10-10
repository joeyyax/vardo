import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "util";

// The bounded builder exports for the daemon's image store; anything it can't read falls back to --load.

const { execFileMock, info } = vi.hoisted(() => ({
  execFileMock: vi.fn() as unknown as Record<symbol, unknown>,
  info: { stdout: "" as string | null, calls: 0 },
}));

(execFileMock as Record<symbol, unknown>)[promisify.custom] = async () => {
  info.calls++;
  if (info.stdout === null) throw new Error("Cannot connect to the Docker daemon");
  return { stdout: info.stdout, stderr: "" };
};

vi.mock("child_process", () => ({ execFile: execFileMock }));

const { detectImageStore, exportArgs, exportOutput, exportStore, parseImageStore, resetImageStoreCache } = await import(
  "@/lib/docker/build-export"
);

const CONTAINERD = 'overlayfs|[["driver-type","io.containerd.snapshotter.v1"]]';
const OVERLAY2 = 'overlay2|[["Backing Filesystem","extfs"],["Supports d_type","true"],["Using metacopy","false"]]';

beforeEach(() => {
  resetImageStoreCache();
  info.calls = 0;
  info.stdout = OVERLAY2;
  delete process.env.VARDO_BUILD_EXPORT;
});

afterEach(() => {
  delete process.env.VARDO_BUILD_EXPORT;
});

describe("parseImageStore", () => {
  it("recognizes the containerd image store", () => {
    expect(parseImageStore(CONTAINERD)).toBe("containerd");
  });

  it("treats a graph driver as the classic store", () => {
    expect(parseImageStore(OVERLAY2)).toBe("classic");
    expect(parseImageStore("overlay2|null")).toBe("classic");
  });

  it("is unknown when docker info says nothing usable", () => {
    expect(parseImageStore("")).toBe("unknown");
    expect(parseImageStore("overlay2|not json")).toBe("unknown");
  });
});

describe("exportArgs", () => {
  it("exports zstd layers for the containerd store", () => {
    expect(exportOutput("containerd")).toBe("type=docker,compression=zstd");
    expect(exportArgs("containerd")).toEqual([
      "--output", "type=docker,compression=zstd", "--provenance=false", "--sbom=false",
    ]);
  });

  it("exports uncompressed layers for the classic store", () => {
    expect(exportArgs("classic")[1]).toBe("type=docker,compression=uncompressed");
  });

  it("falls back to --load when the store is unknown", () => {
    expect(exportOutput("unknown")).toBeNull();
    expect(exportArgs("unknown")).toEqual(["--load"]);
  });
});

describe("detectImageStore", () => {
  it("reads docker info once and caches the answer", async () => {
    info.stdout = CONTAINERD;
    expect(await detectImageStore()).toBe("containerd");
    expect(await detectImageStore()).toBe("containerd");
    expect(info.calls).toBe(1);
  });

  it("is unknown, and asks again next time, when docker info fails", async () => {
    info.stdout = null;
    expect(await detectImageStore()).toBe("unknown");
    info.stdout = OVERLAY2;
    expect(await detectImageStore()).toBe("classic");
    expect(info.calls).toBe(2);
  });

  it("skips detection when VARDO_BUILD_EXPORT=load", async () => {
    process.env.VARDO_BUILD_EXPORT = "load";
    expect(await exportStore()).toBe("unknown");
    expect(info.calls).toBe(0);
  });
});
