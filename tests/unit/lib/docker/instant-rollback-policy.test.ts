// Instant rollback starts the standby slot's files, so an untrusted app's pre-#886 standby is checked first (#895).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileAsyncMock, assertMock, clearPinMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  assertMock: vi.fn(),
  clearPinMock: vi.fn(),
}));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync: execFileAsyncMock }));
vi.mock("@/lib/db", () => ({ db: { update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) } }));
vi.mock("@/lib/docker/slot-guard", () => ({ assertSlotWithinApp: assertMock }));
vi.mock("@/lib/docker/deploy-cancel", () => ({
  claimAppForOperation: vi.fn().mockResolvedValue({ release: vi.fn() }),
}));
vi.mock("@/lib/docker/traefik-cutover", () => ({ clearCutoverPin: clearPinMock }));
vi.mock("@/lib/docker/restart-policy", () => ({
  demoteStandbyRestart: vi.fn(),
  restoreSlotRestart: vi.fn(),
}));
vi.mock("@/lib/docker/compose", () => ({ slotComposeFiles: vi.fn().mockResolvedValue(["-f", "docker-compose.yml"]) }));
vi.mock("@/lib/docker/slots", () => ({ detectActiveSlot: vi.fn().mockResolvedValue("green") }));
vi.mock("@/lib/docker/shared-project", () => ({ readSlotPartition: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

import { performInstantRollback } from "@/lib/docker/instant-rollback";
import { DeployBlockedError } from "@/lib/docker/errors";

const rollback = () =>
  performInstantRollback({
    appId: "a1",
    appName: "blog",
    organizationId: "o1",
    userId: "u1",
    env: { name: "production", type: "production", id: "e1" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  clearPinMock.mockResolvedValue(undefined);
  // The standby has a stopped container to bring back.
  execFileAsyncMock.mockResolvedValue({ stdout: '{"State":"exited"}\n', stderr: "" });
});

describe("instant rollback policy check", () => {
  it("refuses a standby that reaches outside the app before starting it", async () => {
    assertMock.mockRejectedValue(new DeployBlockedError("Couldn't rollback: Redeploy the app"));

    const result = await rollback();

    expect(result).toMatchObject({ success: false, fromSlot: "green", toSlot: "blue" });
    expect(result.error).toContain("Redeploy");
    expect(assertMock).toHaveBeenCalledWith(expect.objectContaining({ reuse: "rollback", composeProject: "blog-production-blue" }));
    const ups = execFileAsyncMock.mock.calls.filter((c) => (c[1] as string[]).includes("up"));
    expect(ups).toHaveLength(0);
    expect(clearPinMock).not.toHaveBeenCalled();
  });

  it("goes ahead once the check passes", async () => {
    assertMock.mockResolvedValue(undefined);

    // Later steps need more of the database than this test mocks.
    await rollback().catch(() => {});

    const ups = execFileAsyncMock.mock.calls.filter((c) => (c[1] as string[]).includes("up"));
    expect(ups.length).toBeGreaterThan(0);
  });
});
