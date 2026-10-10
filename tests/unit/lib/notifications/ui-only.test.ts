import { describe, it, expect } from "vitest";
import { isUiOnlyEvent } from "@/lib/notifications/ui-only";
import { resolveRecipients } from "@/lib/notifications/resolve-recipients";
import { EVENT_CATEGORIES, ALL_EVENT_TYPES } from "@/lib/bus/events";
import type { BusEvent } from "@/lib/bus/events";

function deployStatus(status: "running" | "active" | "error" | "cancelled" | "superseded"): BusEvent {
  return {
    type: "deploy.status",
    title: "t",
    message: "m",
    appId: "a1",
    deploymentId: "d1",
    status,
    success: status === "active",
  };
}

describe("isUiOnlyEvent", () => {
  it("keeps every deploy status off notification channels", () => {
    for (const status of ["running", "active", "error", "cancelled", "superseded"] as const) {
      expect(isUiOnlyEvent(deployStatus(status))).toBe(true);
    }
  });

  it("lets other events through", () => {
    expect(
      isUiOnlyEvent({
        type: "deploy.success",
        title: "t",
        message: "m",
        projectName: "p",
        appId: "a1",
        deploymentId: "d1",
        duration: "1s",
      }),
    ).toBe(false);
  });
});

describe("deploy.status", () => {
  it("never resolves a recipient, even when a member opted in", () => {
    const members = [{ userId: "user-1" }];
    const prefs = [{ channelId: "chan-1", userId: "user-1", enabled: true }];
    for (const channelType of ["email", "slack", "webhook", "ntfy", "discord", "telegram", "pushover"]) {
      expect(resolveRecipients("chan-1", channelType, "deploy.status", members, prefs).shouldSend).toBe(false);
    }
  });

  it("isn't offered as a subscribable event", () => {
    expect(EVENT_CATEGORIES.deploy).not.toContain("deploy.status");
    expect(ALL_EVENT_TYPES).not.toContain("deploy.status");
  });
});
