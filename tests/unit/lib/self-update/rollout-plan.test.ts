import { describe, expect, it } from "vitest";
import { hasRolloutFailure, nextReadyMembers, rolloutDone, type Rollout, type RolloutMember } from "@/lib/self-update/rollout-plan";

function member(instanceId: string, priority: RolloutMember["priority"], state: RolloutMember["state"] = "waiting"): RolloutMember {
  return { instanceId, name: instanceId, priority, state, fromSha: "abc1234", reason: null, busySince: null, notifiedBusyAt: null, deploymentId: null };
}

function rollout(members: RolloutMember[]): Rollout {
  return { id: "r1", targetSha: "def5678", targetLabel: "v1", channel: "releases", startedAt: "2026-10-12T00:00:00Z", finishedAt: null, state: "running", immediate: false, pendingSha: null, notices: [], members };
}

describe("instance rollout plan", () => {
  it("starts ready critical instances first without holding ready lower priorities for a busy one", () => {
    const plan = rollout([member("busy-critical", "critical", "busy"), member("low", "low"), member("standard", "standard"), member("critical", "critical")]);
    expect(nextReadyMembers(plan, new Set(["low", "standard", "critical"]), 2).map((item) => item.instanceId)).toEqual(["critical", "standard"]);
  });

  it("limits concurrent updates and allows the operator to skip priority order", () => {
    const plan = rollout([member("a-low", "low"), member("z-critical", "critical"), member("updating", "critical", "updating")]);
    expect(nextReadyMembers(plan, new Set(["a-low", "z-critical"]), 2).map((item) => item.instanceId)).toEqual(["z-critical"]);
    plan.immediate = true;
    expect(nextReadyMembers(plan, new Set(["a-low", "z-critical"]), 2).map((item) => item.instanceId)).toEqual(["a-low"]);
  });

  it("waits for in-flight work before replacing a release", () => {
    const plan = rollout([member("ready", "critical")]);
    plan.pendingSha = "fedcba9";
    expect(nextReadyMembers(plan, new Set(["ready"]), 2)).toEqual([]);
  });

  it("finishes with skipped instances and pauses for failed or unreachable ones", () => {
    const plan = rollout([member("done", "critical", "verified"), member("later", "standard", "skipped")]);
    expect(rolloutDone(plan)).toBe(true);
    plan.members.push(member("offline", "low", "unreachable"));
    expect(rolloutDone(plan)).toBe(false);
    expect(hasRolloutFailure(plan)).toBe(true);
  });
});
