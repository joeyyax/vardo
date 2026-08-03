import { describe, it, expect } from "vitest";
import { isUiOnlyEvent } from "@/lib/notifications/ui-only";
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
  it("keeps a deploy start off notification channels", () => {
    expect(isUiOnlyEvent(deployStatus("running"))).toBe(true);
  });

  it("lets terminal deploy statuses through", () => {
    expect(isUiOnlyEvent(deployStatus("active"))).toBe(false);
    expect(isUiOnlyEvent(deployStatus("error"))).toBe(false);
    expect(isUiOnlyEvent(deployStatus("cancelled"))).toBe(false);
    expect(isUiOnlyEvent(deployStatus("superseded"))).toBe(false);
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
