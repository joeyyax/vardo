import { beforeEach, describe, expect, it, vi } from "vitest";

const LOCAL = "a".repeat(40);
const TARGET = "b".repeat(40);

const h = vi.hoisted(() => ({
  compare: null as { status: string } | null,
  gates: [] as { gate: string; reason: string }[],
  startUpdate: vi.fn(),
}));

vi.mock("@/lib/version", () => ({ getBuildSha: () => "a".repeat(40), fetchCompare: async () => h.compare }));
vi.mock("@/lib/paths", () => ({ isSelfDeployLayout: () => true }));
vi.mock("@/lib/self-update/gates", () => ({ evaluateGates: () => h.gates }));
vi.mock("@/lib/self-update/runner", () => ({
  collectGateInputs: async () => ({}),
  startUpdate: h.startUpdate,
}));
vi.mock("@/lib/self-update/store", () => ({
  getUpdatePolicy: async () => ({ mode: "auto", priority: "standard", channel: "main" }),
  getUpdateRun: async () => null,
  getUpdateState: async () => ({ failedTargets: [], versionSince: null }),
  setUpdateRun: async () => {},
  updateState: async () => ({}),
}));

const { readPeerReadiness, startPeerRollout } = await import("@/lib/self-update/rollout-peer");

beforeEach(() => {
  h.compare = { status: "ahead" };
  h.gates = [];
  h.startUpdate.mockReset().mockResolvedValue({ deploymentId: "d1" });
});

describe("peer rollout readiness", () => {
  it("reports a build already past the target as done and never starts it", async () => {
    h.compare = { status: "behind" };
    const report = await startPeerRollout(TARGET, "v1", "main", "r1");
    expect(report).toMatchObject({ state: "verified", sha: LOCAL, reason: "Already past this target" });
    expect(h.startUpdate).not.toHaveBeenCalled();
  });

  it("reports past even while a busy gate is closed", async () => {
    h.compare = { status: "behind" };
    h.gates = [{ gate: "busy", reason: "Deploy running" }];
    expect((await readPeerReadiness(TARGET, "main", "r1")).state).toBe("verified");
  });

  it("starts a build that is behind the target", async () => {
    const report = await startPeerRollout(TARGET, "v1", "main", "r1");
    expect(report.state).toBe("updating");
    expect(h.startUpdate).toHaveBeenCalledOnce();
  });

  it("still starts when the compare fails", async () => {
    h.compare = null;
    expect((await startPeerRollout(TARGET, "v1", "main", "r1")).state).toBe("updating");
    expect(h.startUpdate).toHaveBeenCalledOnce();
  });
});
