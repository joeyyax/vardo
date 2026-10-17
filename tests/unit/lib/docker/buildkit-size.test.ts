import { describe, it, expect, vi, beforeEach } from "vitest";

// BuildKit's memory sized to the host before a build goes into an empty builder.

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const { state } = vi.hoisted(() => ({
  state: {
    meminfo: "",
    limits: { Memory: 0, MemorySwap: 0 } as { Memory?: number; MemorySwap?: number } | null,
    updates: [] as unknown[],
    updateFails: false,
  },
}));

vi.mock("fs/promises", async (original) => ({
  ...(await original<typeof import("fs/promises")>()),
  readFile: vi.fn(async (path: string) => {
    if (path === "/proc/meminfo") return state.meminfo;
    throw new Error("ENOENT");
  }),
}));
vi.mock("@/lib/docker/client", () => ({
  dockerRequest: vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === "GET" && path.endsWith("/json")) {
      if (!state.limits) throw new Error("no such container");
      return { HostConfig: state.limits };
    }
    if (method === "POST" && path.endsWith("/update")) {
      if (state.updateFails) throw new Error("update refused");
      state.updates.push(body);
      return {};
    }
    throw new Error(`unexpected ${method} ${path}`);
  }),
}));

const { buildkitSize, buildersFit, pinnedBuildKitMem, pinnedMeshBuilderMem, sizeBuildKit } = await import("@/lib/docker/buildkit-size");

const meminfo = (totalBytes: number, availableBytes: number) =>
  `MemTotal:       ${Math.round(totalBytes / 1024)} kB\nMemFree:        1024 kB\nMemAvailable:   ${Math.round(availableBytes / 1024)} kB\n`;

describe("buildkitSize", () => {
  it("gives jy0's build about 6 GiB: 7 GiB free plus what BuildKit holds, less the apps' reserve", () => {
    const size = buildkitSize({ totalBytes: 15.6 * GiB, availableBytes: 7 * GiB, builderBytes: 0.57 * GiB });
    expect(size.memoryBytes).toBe(6 * GiB);
    expect(size.memorySwapBytes).toBe(size.memoryBytes);
    expect(size.reserveBytes).toBeCloseTo(1.56 * GiB, -6);
    expect(size.floored).toBe(false);
  });

  it("stops at half of RAM on an idle host", () => {
    expect(buildkitSize({ totalBytes: 32 * GiB, availableBytes: 28 * GiB, builderBytes: 0 }).memoryBytes).toBe(16 * GiB);
  });

  it("keeps the 4 GiB floor on a busy host", () => {
    const size = buildkitSize({ totalBytes: 16 * GiB, availableBytes: 2 * GiB, builderBytes: 0 });
    expect(size).toMatchObject({ memoryBytes: 4 * GiB, floored: true });
  });

  it("gives a 2 GiB host 70% of RAM and as much again in swap", () => {
    const size = buildkitSize({ totalBytes: 2 * GiB, availableBytes: 0.8 * GiB, builderBytes: 0 });
    expect(size.memoryBytes).toBe(Math.floor((1.4 * GiB) / (64 * MiB)) * 64 * MiB);
    expect(size.memorySwapBytes).toBe(size.memoryBytes * 2);
    expect(size.floored).toBe(true);
  });

  it("leaves room for what another busy builder can still grow into", () => {
    const size = buildkitSize({ totalBytes: 48 * GiB, availableBytes: 30 * GiB, builderBytes: 0, otherHeadroomBytes: 11 * GiB });
    expect(size.memoryBytes).toBe(Math.floor(((30 - 4.8 - 11) * GiB) / (64 * MiB)) * 64 * MiB);
  });

  it("moves in 64 MiB steps", () => {
    const size = buildkitSize({ totalBytes: 16 * GiB, availableBytes: 7 * GiB + 100 * MiB, builderBytes: 0 });
    expect(size.memoryBytes % (64 * MiB)).toBe(0);
  });
});

describe("buildersFit", () => {
  const host = { totalBytes: 48 * GiB, availableBytes: 20 * GiB };

  it("takes a peer's 12 GiB build within free memory less a tenth of RAM", () => {
    expect(buildersFit({ ...host, meshHeadroomBytes: 12 * GiB, buildkitHeadroomBytes: 0 })).toBe(true);
  });

  it("refuses one that could grow with this host's own builds into the apps' reserve", () => {
    expect(buildersFit({ ...host, meshHeadroomBytes: 12 * GiB, buildkitHeadroomBytes: 6 * GiB })).toBe(false);
  });

  it("keeps at least 1 GiB for the apps on a small host", () => {
    expect(buildersFit({ totalBytes: 4 * GiB, availableBytes: 4.5 * GiB, meshHeadroomBytes: 3.5 * GiB, buildkitHeadroomBytes: 0 })).toBe(true);
    expect(buildersFit({ totalBytes: 4 * GiB, availableBytes: 4.4 * GiB, meshHeadroomBytes: 3.5 * GiB, buildkitHeadroomBytes: 0 })).toBe(false);
  });
});

describe("pinnedBuildKitMem", () => {
  it("leaves what install.sh writes to autosizing", () => {
    expect(pinnedBuildKitMem({ VARDO_BUILDKIT_MEM: "4g" }, 15.6 * GiB)).toBeNull();
    expect(pinnedBuildKitMem({}, 15.6 * GiB)).toBeNull();
  });

  it("pins any other value", () => {
    expect(pinnedBuildKitMem({ VARDO_BUILDKIT_MEM: "6g" }, 15.6 * GiB)).toBe(6 * GiB);
  });
});

describe("pinnedMeshBuilderMem", () => {
  it("follows vardo-buildkit's pin when VARDO_MESH_BUILDER_MEM is unset", () => {
    expect(pinnedMeshBuilderMem({ VARDO_BUILDKIT_MEM: "4g" }, 15.6 * GiB)).toBeNull();
    expect(pinnedMeshBuilderMem({ VARDO_BUILDKIT_MEM: "4g", VARDO_MESH_BUILDER_MEM: " " }, 15.6 * GiB)).toBeNull();
    expect(pinnedMeshBuilderMem({ VARDO_BUILDKIT_MEM: "6g" }, 15.6 * GiB)).toBe(6 * GiB);
  });

  it("pins any VARDO_MESH_BUILDER_MEM, even the install default", () => {
    expect(pinnedMeshBuilderMem({ VARDO_BUILDKIT_MEM: "4g", VARDO_MESH_BUILDER_MEM: "4g" }, 15.6 * GiB)).toBe(4 * GiB);
    expect(pinnedMeshBuilderMem({ VARDO_MESH_BUILDER_MEM: "12g" }, 15.6 * GiB)).toBe(12 * GiB);
  });
});

describe("sizeBuildKit", () => {
  beforeEach(() => {
    state.meminfo = meminfo(15.6 * GiB, 7 * GiB);
    state.limits = { Memory: 4 * GiB, MemorySwap: 4 * GiB };
    state.updates = [];
    state.updateFails = false;
  });

  const run = (env: Record<string, string | undefined> = {}, builder = 0.57 * GiB, extra: Partial<Parameters<typeof sizeBuildKit>[1]> = {}) => {
    const lines: string[] = [];
    return sizeBuildKit("vardo-buildkit", { builderBytes: async () => builder, log: (l) => lines.push(l), env, ...extra }).then((bytes) => ({ bytes, lines }));
  };

  it("grows a busy builder but never shrinks it", async () => {
    expect((await run({}, 0.57 * GiB, { shrink: false })).bytes).toBe(6 * GiB);
    state.updates = [];
    state.limits = { Memory: 7 * GiB, MemorySwap: 7 * GiB };
    expect((await run({}, 0.57 * GiB, { shrink: false })).bytes).toBeNull();
    state.limits = { Memory: 0, MemorySwap: 0 };
    expect((await run({}, 0.57 * GiB, { shrink: false })).bytes).toBeNull();
    expect(state.updates).toEqual([]);
  });

  it("shrinks an idle one", async () => {
    state.limits = { Memory: 7 * GiB, MemorySwap: 7 * GiB };
    expect((await run()).bytes).toBe(6 * GiB);
  });

  it("uses the pin rule it's given and says what the other builder keeps", async () => {
    expect((await run({ VARDO_MESH_BUILDER_MEM: "8g" }, 0.57 * GiB, { pinned: pinnedMeshBuilderMem })).bytes).toBeNull();
    state.meminfo = meminfo(48 * GiB, 30 * GiB);
    const { bytes, lines } = await run({}, 0, { pinned: pinnedMeshBuilderMem, otherHeadroomBytes: async () => 11 * GiB });
    expect(bytes).toBe(Math.floor(((30 - 4.8 - 11) * GiB) / (64 * MiB)) * 64 * MiB);
    expect(lines).toEqual(["[build] Sized vardo-buildkit to 14.2 GiB: 30.0 GiB free on the host, 4.8 GiB kept for apps, 11.0 GiB for the other builder's builds"]);
  });

  it("resizes BuildKit live and says why", async () => {
    const { bytes, lines } = await run();
    expect(bytes).toBe(6 * GiB);
    expect(state.updates).toEqual([{ Memory: 6 * GiB, MemorySwap: 6 * GiB }]);
    expect(lines).toEqual(["[build] Sized vardo-buildkit to 6.0 GiB: 7.0 GiB free on the host, 1.6 GiB kept for apps"]);
  });

  it("leaves a pinned size alone", async () => {
    const { bytes } = await run({ VARDO_BUILDKIT_MEM: "6g" });
    expect(bytes).toBeNull();
    expect(state.updates).toEqual([]);
  });

  it("skips a resize within a step of the current limit", async () => {
    state.limits = { Memory: 6 * GiB + 10 * MiB, MemorySwap: 6 * GiB + 10 * MiB };
    expect((await run()).bytes).toBeNull();
    expect(state.updates).toEqual([]);
  });

  it("builds at the current limit when Docker refuses the update", async () => {
    state.updateFails = true;
    const { bytes, lines } = await run();
    expect(bytes).toBeNull();
    expect(lines[0]).toMatch(/couldn't resize vardo-buildkit/);
  });

  it("does nothing without /proc/meminfo or the container", async () => {
    state.meminfo = "";
    expect((await run()).bytes).toBeNull();
    state.meminfo = meminfo(15.6 * GiB, 7 * GiB);
    state.limits = null;
    expect((await run()).bytes).toBeNull();
    expect(state.updates).toEqual([]);
  });
});
