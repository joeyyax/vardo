import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  selfDeploy: vi.fn(),
  startUpdate: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("child_process", () => ({ spawn: h.spawn }));
vi.mock("@/lib/paths", () => ({ isSelfDeployLayout: h.selfDeploy, VARDO_HOME_DIR: "/opt/vardo" }));
vi.mock("@/lib/version", () => ({ getChannelUpdate: async (channel: string) => ({ channel, targetLabel: "1.3.0" }) }));
vi.mock("@/lib/self-update/store", () => ({ getUpdatePolicy: async () => ({ mode: "auto", priority: "standard", channel: null }) }));
vi.mock("@/lib/self-update/runner", () => ({ startUpdate: h.startUpdate }));

import { updateNow } from "@/lib/self-update/update-now";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("updateNow", () => {
  it("starts a manual update on the policy's channel for a self-deployed install", async () => {
    h.selfDeploy.mockReturnValue(true);
    h.startUpdate.mockResolvedValue({ deploymentId: "d1", toLabel: "1.3.0" });
    const result = await updateNow("u1");
    expect(h.startUpdate).toHaveBeenCalledWith(expect.objectContaining({ trigger: "manual", triggeredBy: "u1", channel: "releases" }));
    expect(result).toEqual({ ok: true, deploymentId: "d1", message: "Updating Vardo to 1.3.0." });
  });

  it("lets a blocked update propagate", async () => {
    h.selfDeploy.mockReturnValue(true);
    h.startUpdate.mockRejectedValue(new Error("blocked"));
    await expect(updateNow("u1")).rejects.toThrow("blocked");
  });

  it("runs install.sh in the background on a legacy install", async () => {
    h.selfDeploy.mockReturnValue(false);
    const result = await updateNow("u1");
    expect(result.ok).toBe(true);
    expect(h.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.spawn).toHaveBeenCalledWith("bash", ["/opt/vardo/install.sh", "update", "--yes"], expect.objectContaining({ detached: true }));
    expect(h.startUpdate).not.toHaveBeenCalled();
  });
});
