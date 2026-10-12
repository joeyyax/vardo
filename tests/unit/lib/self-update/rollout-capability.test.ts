import { describe, expect, it } from "vitest";
import { parseRolloutCapability, rolloutCapability } from "@/lib/self-update/rollout-capability";

describe("mesh rollout capability", () => {
  it("advertises the instance's update policy", () => {
    expect(rolloutCapability({ mode: "auto", priority: "critical", channel: null })).toEqual({ protocol: 1, mode: "auto", priority: "critical", channel: "releases" });
  });

  it("rejects old or malformed peer reports", () => {
    expect(parseRolloutCapability(null)).toBeNull();
    expect(parseRolloutCapability({ protocol: 0, mode: "auto", priority: "critical", channel: "releases" })).toBeNull();
    expect(parseRolloutCapability({ protocol: 1, mode: "auto", priority: "urgent", channel: "releases" })).toBeNull();
  });
});
