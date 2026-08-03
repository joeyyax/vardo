import { describe, it, expect } from "vitest";
import { toastSeverityFor } from "@/lib/bus/toasts";
import type { AppAutoRestartedEvent, BusEvent } from "@/lib/bus/events";

function autoRestarted(over: Partial<AppAutoRestartedEvent> = {}): BusEvent {
  return {
    type: "app.auto-restarted",
    title: "Restarted web",
    message: "Container was unhealthy",
    appId: "a1",
    appName: "web",
    containerName: "web-1",
    containerId: "c1",
    reason: "unhealthy",
    success: true,
    gaveUp: false,
    ...over,
  };
}

describe("toastSeverityFor", () => {
  it("surfaces a self-heal", () => {
    expect(toastSeverityFor(autoRestarted())).toBe("info");
  });

  it("escalates a self-heal that gave up", () => {
    expect(toastSeverityFor(autoRestarted({ gaveUp: true }))).toBe("error");
  });

  it("stays quiet for low-signal events", () => {
    expect(
      toastSeverityFor({
        type: "org.invitation-sent",
        title: "t",
        message: "m",
        inviteeEmail: "a@b.c",
        invitedBy: "me",
      }),
    ).toBeUndefined();
  });

  it("does not toast the deploy start that drives the live UI", () => {
    expect(
      toastSeverityFor({
        type: "deploy.status",
        title: "Deploy started",
        message: "m",
        appId: "a1",
        deploymentId: "d1",
        status: "running",
        success: false,
      }),
    ).toBeUndefined();
  });
});
