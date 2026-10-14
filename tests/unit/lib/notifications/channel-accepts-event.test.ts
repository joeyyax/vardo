import { describe, expect, it } from "vitest";
import { channelAcceptsEvent } from "@/lib/notifications/channel-defaults";

describe("channelAcceptsEvent", () => {
  it("routes rollout pauses and busy waits to channels still subscribed to system.update-skipped", () => {
    expect(channelAcceptsEvent(["system.update-skipped"], "system.rollout-paused")).toBe(true);
    expect(channelAcceptsEvent(["system.update-skipped"], "system.rollout-busy")).toBe(true);
  });

  it("does not widen system.update-skipped to other rollout events", () => {
    expect(channelAcceptsEvent(["system.update-skipped"], "system.rollout-finished")).toBe(false);
  });
});
