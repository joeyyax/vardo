// Restart and recreate stop at the policy check: no compose restart or up runs against a refused slot (#895).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileAsyncMock, assertMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  assertMock: vi.fn(),
}));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execFileAsyncMock }));
vi.mock("fs/promises", async (original) => ({
  ...(await original<typeof import("fs/promises")>()),
  access: vi.fn().mockResolvedValue(undefined),
  readlink: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));
vi.mock("@/lib/db", () => ({ db: { update: vi.fn() } }));
vi.mock("@/lib/docker/slot-guard", () => ({ assertSlotWithinApp: assertMock }));
vi.mock("@/lib/docker/slots", async (original) => ({
  ...(await original<typeof import("@/lib/docker/slots")>()),
  detectActiveSlot: vi.fn().mockResolvedValue("blue"),
}));
vi.mock("@/lib/docker/compose", () => ({ slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]) }));
vi.mock("@/lib/docker/shared-project", async (original) => ({
  ...(await original<typeof import("@/lib/docker/shared-project")>()),
  readSlotPartition: vi.fn().mockResolvedValue(null),
}));

import { restartContainers, recreateProject } from "@/lib/docker/deploy";
import { DeployBlockedError } from "@/lib/docker/errors";

beforeEach(() => {
  vi.clearAllMocks();
  execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("slot policy on restart and recreate", () => {
  it("refuses restart without running compose", async () => {
    assertMock.mockRejectedValue(new DeployBlockedError("Couldn't restart: redeploy"));

    const result = await restartContainers("blog", "production");

    expect(result.success).toBe(false);
    expect(result.log).toContain("Couldn't restart");
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(assertMock).toHaveBeenCalledWith(expect.objectContaining({ appName: "blog", envName: "production", reuse: "restart" }));
  });

  it("refuses recreate without running compose", async () => {
    assertMock.mockRejectedValue(new DeployBlockedError("Couldn't recreate: redeploy"));

    const result = await recreateProject("a1", "blog", "production");

    expect(result.success).toBe(false);
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(assertMock).toHaveBeenCalledWith(expect.objectContaining({ reuse: "recreate" }));
  });

  it("restarts once the check passes", async () => {
    assertMock.mockResolvedValue(undefined);

    const result = await restartContainers("blog", "production");

    expect(result.success).toBe(true);
    expect(execFileAsyncMock.mock.calls[0][1]).toContain("restart");
  });
});
