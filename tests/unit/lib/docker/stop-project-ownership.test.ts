import { describe, it, expect, beforeEach, vi } from "vitest";

const { updateMock, updateSetMock, updateWhereMock, execFileMock, assertOwnershipMock } = vi.hoisted(
  () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    return {
      updateMock: vi.fn(() => ({ set })),
      updateSetMock: set,
      updateWhereMock: where,
      execFileMock: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      assertOwnershipMock: vi.fn().mockResolvedValue(undefined),
    };
  },
);

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: execFileMock,
    configurable: true,
    writable: true,
  });
  return { ...actual, execFile };
});
vi.mock("@/lib/db", () => ({
  db: {
    update: updateMock,
    query: {
      environments: {
        findFirst: vi.fn().mockResolvedValue({ id: "env-prod", name: "production", type: "production" }),
      },
    },
  },
}));
vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/docker/deploy-steps", () => ({
  prepareRepo: vi.fn(),
  resolveCompose: vi.fn(),
  build: vi.fn(),
  swap: vi.fn(),
  postDeploy: vi.fn(),
}));
vi.mock("@/lib/docker/app-dir-owner", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker/app-dir-owner")>(
    "@/lib/docker/app-dir-owner",
  );
  return { ...actual, assertAppDirOwnership: assertOwnershipMock };
});

import { stopProject } from "@/lib/docker/deploy";
import { AppDirOwnershipError } from "@/lib/docker/app-dir-owner";

beforeEach(() => {
  vi.clearAllMocks();
  execFileMock.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  assertOwnershipMock.mockResolvedValue(undefined);
});

describe("stopProject ownership guard", () => {
  it("reports the refusal in the log and runs no compose command", async () => {
    assertOwnershipMock.mockRejectedValue(
      new AppDirOwnershipError("Refusing to stop \"api\": /opt/vardo/apps/api is owned by app app-1", "app-2", "api"),
    );

    const result = await stopProject("app-2", "api", undefined, true);

    expect(result.success).toBe(false);
    expect(result.log).toContain("ERROR: Refusing to stop");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("leaves the app status untouched when it refuses", async () => {
    assertOwnershipMock.mockRejectedValue(
      new AppDirOwnershipError("Refusing to stop \"api\"", "app-2", "api"),
    );

    await stopProject("app-2", "api");

    expect(updateMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(updateWhereMock).not.toHaveBeenCalled();
  });

  it("checks ownership before removing volumes", async () => {
    await stopProject("app-1", "api", "production", true);

    expect(assertOwnershipMock).toHaveBeenCalledWith({
      appId: "app-1",
      appName: "api",
      operation: "stop and remove volumes for",
    });
  });

  it("leaves the app status alone when stopping a non-default environment", async () => {
    const result = await stopProject("app-1", "api", "pr-3");

    expect(result.success).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("marks the app stopped when stopping its default environment", async () => {
    await stopProject("app-1", "api", "production");

    expect(updateMock).toHaveBeenCalled();
  });

  it("reports a failed compose down without marking the app stopped", async () => {
    execFileMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes("down")) throw new Error("Docker daemon unavailable");
      return { stdout: "", stderr: "" };
    });

    const result = await stopProject("app-1", "api", "production");

    expect(result).toMatchObject({ success: false });
    expect(result.log).toContain("Docker daemon unavailable");
    expect(updateMock).not.toHaveBeenCalled();
  });
});
