import { describe, it, expect } from "vitest";
import { toastActionFor } from "@/lib/bus/toast-action";
import { TOAST_EVENTS } from "@/lib/bus/toasts";
import type { BusEvent } from "@/lib/bus/events";

const base = { title: "t", message: "m", appId: "a1" };

function event(type: string): BusEvent {
  return { ...base, type } as unknown as BusEvent;
}

describe("toastActionFor", () => {
  it("links every toastable event for an admin", () => {
    for (const type of Object.keys(TOAST_EVENTS)) {
      expect(toastActionFor(event(type), { canLinkToAdmin: true }), type).toBeDefined();
    }
  });

  it("links app events to the app by id", () => {
    expect(toastActionFor(event("deploy.failed"), { canLinkToAdmin: false })?.url).toBe(
      "/apps/a1/deployments",
    );
  });

  it("holds back instance links from non-admins", () => {
    for (const type of ["system.service-down", "system.disk-alert", "system.restart-loop", "system.cert-expiring"]) {
      expect(toastActionFor(event(type), { canLinkToAdmin: false }), type).toBeUndefined();
    }
  });
});
