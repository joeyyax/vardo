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

(execFileMock as Record<symbol, unknown>)[promisify.custom] = (...args: unknown[]) => {
  calls.push(args);
  return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
};

vi.mock("child_process", () => ({ execFile: execFileMock }));

const { assertBuildKitReachable, buildKitContainerName, DEFAULT_BUILDKIT_HOST } = await import(
  "@/lib/docker/buildkit"
);

beforeEach(() => {
  calls.length = 0;
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
