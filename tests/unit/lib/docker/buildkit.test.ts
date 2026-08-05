import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "util";

// `promisify(execFile)` resolves through the promisify.custom symbol, the same
// as the real child_process export. Setting it here keeps the mock independent
// of callback arity.
const { execFileMock, calls } = vi.hoisted(() => ({
  execFileMock: vi.fn() as unknown as Record<symbol, unknown> & { mock: { calls: unknown[][] } },
  calls: [] as unknown[][],
}));

let response: { stdout: string } | Error = { stdout: "true\n" };

/** Consumed one per call, ahead of `response`, for calls that shell out twice. */
const queued: ({ stdout: string } | Error)[] = [];

(execFileMock as Record<symbol, unknown>)[promisify.custom] = (...args: unknown[]) => {
  calls.push(args);
  const next = queued.shift() ?? response;
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
};

vi.mock("child_process", () => ({ execFile: execFileMock }));

const {
  assertBuildKitReachable,
  isBuildKitReachable,
  buildKitContainerName,
  pruneBuildKitCache,
  DEFAULT_BUILDKIT_HOST,
} = await import("@/lib/docker/buildkit");

beforeEach(() => {
  calls.length = 0;
  queued.length = 0;
  response = { stdout: "true\n" };
});

describe("buildKitContainerName", () => {
  it("reads the container out of a docker-container host", () => {
    expect(buildKitContainerName("docker-container://vardo-buildkit")).toBe("vardo-buildkit");
  });

  it("ignores transports it cannot check", () => {
    expect(buildKitContainerName("tcp://10.0.0.5:1234")).toBeNull();
    expect(buildKitContainerName("unix:///run/buildkit/buildkitd.sock")).toBeNull();
  });

  it("treats an empty container name as no container", () => {
    expect(buildKitContainerName("docker-container://")).toBeNull();
    expect(buildKitContainerName("docker-container://   ")).toBeNull();
  });

  it("the default host names a checkable container", () => {
    expect(buildKitContainerName(DEFAULT_BUILDKIT_HOST)).toBe("vardo-buildkit");
  });
});

describe("assertBuildKitReachable", () => {
  it("passes when the container reports running", async () => {
    response = { stdout: "true\n" };
    await expect(assertBuildKitReachable(DEFAULT_BUILDKIT_HOST)).resolves.toBeUndefined();
  });

  it("blocks the deploy when the container is stopped", async () => {
    response = { stdout: "false\n" };
    await expect(assertBuildKitReachable(DEFAULT_BUILDKIT_HOST)).rejects.toThrow(/needs BuildKit/);
  });

  it("blocks the deploy when the container does not exist", async () => {
    response = new Error("No such object: buildkit");
    await expect(assertBuildKitReachable(DEFAULT_BUILDKIT_HOST)).rejects.toThrow(/needs BuildKit/);
  });

  it("tells the operator exactly how to fix it", async () => {
    response = new Error("nope");
    const err = assertBuildKitReachable("docker-container://bk");
    await expect(err).rejects.toThrow(/no running container named "bk"/);
    await expect(err).rejects.toThrow(/COMPOSE_PROFILES/);
  });

  it("says Nixpacks needs none of this, so the reader has an out", async () => {
    response = new Error("nope");
    await expect(assertBuildKitReachable(DEFAULT_BUILDKIT_HOST)).rejects.toThrow(/Nixpacks needs none of this/);
  });

  it("inspects the container the host names", async () => {
    await assertBuildKitReachable("docker-container://custom-bk");
    expect(calls[0][1]).toEqual(["inspect", "-f", "{{.State.Running}}", "custom-bk"]);
  });

  it("does not shell out for a transport it cannot check", async () => {
    await expect(assertBuildKitReachable("tcp://10.0.0.5:1234")).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("isBuildKitReachable", () => {
  it("is true when the container reports running", async () => {
    response = { stdout: "true\n" };
    await expect(isBuildKitReachable(DEFAULT_BUILDKIT_HOST)).resolves.toBe(true);
  });

  it("is false when stopped, without throwing — a builder choice, not a failure", async () => {
    response = { stdout: "false\n" };
    await expect(isBuildKitReachable(DEFAULT_BUILDKIT_HOST)).resolves.toBe(false);
  });

  it("is false when the container is absent", async () => {
    response = new Error("No such object");
    await expect(isBuildKitReachable(DEFAULT_BUILDKIT_HOST)).resolves.toBe(false);
  });

  it("takes an uninspectable transport at its word", async () => {
    await expect(isBuildKitReachable("tcp://10.0.0.5:1234")).resolves.toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("pruneBuildKitCache", () => {
  /** Running container, then the prune's per-record sizes. */
  const running = (pruneStdout: string) => {
    queued.push({ stdout: "true\n" }, { stdout: pruneStdout });
  };

  it("prunes inside the container the host names", async () => {
    running("");

    await pruneBuildKitCache(DEFAULT_BUILDKIT_HOST, 10 * 1024 ** 3);

    expect(calls[1][1]).toEqual([
      "exec",
      "vardo-buildkit",
      "buildctl",
      "prune",
      "--keep-storage",
      "10737",
      "--format",
      "{{.Size}}",
    ]);
  });

  it("passes the ceiling in megabytes, which is what buildctl reads", async () => {
    running("");

    await pruneBuildKitCache(DEFAULT_BUILDKIT_HOST, 2 * 1e9);

    expect(calls[1][1]).toContain("2000");
  });

  it("never asks for a ceiling of zero", async () => {
    running("");

    await pruneBuildKitCache(DEFAULT_BUILDKIT_HOST, 1024);

    expect(calls[1][1]).toContain("1");
  });

  it("totals the sizes of the records it reclaimed", async () => {
    running("1048576\n2097152\n524288\n");

    await expect(pruneBuildKitCache(DEFAULT_BUILDKIT_HOST, 10 * 1024 ** 3)).resolves.toEqual({
      spaceReclaimed: 3_670_016,
    });
  });

  it("reclaims nothing when the cache is already under the ceiling", async () => {
    running("\n");

    await expect(pruneBuildKitCache(DEFAULT_BUILDKIT_HOST, 10 * 1024 ** 3)).resolves.toEqual({
      spaceReclaimed: 0,
    });
  });

  it("is a no-op, not an error, when the daemon is not running", async () => {
    response = { stdout: "false\n" };

    await expect(pruneBuildKitCache(DEFAULT_BUILDKIT_HOST, 10 * 1024 ** 3)).resolves.toEqual({
      spaceReclaimed: 0,
    });
    expect(calls).toHaveLength(1);
  });

  it("is a no-op when the container does not exist", async () => {
    response = new Error("No such object: vardo-buildkit");

    await expect(pruneBuildKitCache(DEFAULT_BUILDKIT_HOST, 10 * 1024 ** 3)).resolves.toEqual({
      spaceReclaimed: 0,
    });
  });

  it("leaves a daemon it cannot exec into alone", async () => {
    await expect(pruneBuildKitCache("tcp://10.0.0.5:1234", 10 * 1024 ** 3)).resolves.toEqual({
      spaceReclaimed: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("surfaces a prune that fails, for the caller to swallow", async () => {
    queued.push({ stdout: "true\n" }, new Error("buildctl: not found"));

    await expect(pruneBuildKitCache(DEFAULT_BUILDKIT_HOST, 10 * 1024 ** 3)).rejects.toThrow(
      /buildctl/,
    );
  });
});
