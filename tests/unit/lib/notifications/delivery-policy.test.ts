import { describe, it, expect } from "vitest";
import type { BusEvent } from "@/lib/bus/events";
import { deliveryClass, emailsEvent } from "@/lib/notifications/delivery-policy";

const off = { categories: {} };

describe("delivery policy", () => {
  it("sends failures now and leaves successes to the digest", () => {
    expect(deliveryClass("deploy.failed")).toBe("immediate");
    expect(deliveryClass("cron.failed")).toBe("immediate");
    expect(deliveryClass("deploy.success")).toBe("digest");
    expect(deliveryClass("backup.run-started")).toBe("digest");
  });

  it("batches scans and backup runs", () => {
    expect(deliveryClass("security.scan-findings")).toBe("batch");
    expect(deliveryClass("backup.summary")).toBe("batch");
  });

  it("emails a deploy started by hand, or every deploy once the org opts in", () => {
    const success = { type: "deploy.success", title: "", message: "", projectName: "api", appId: "a", deploymentId: "d", duration: "1s" } as BusEvent;
    expect(emailsEvent({ ...success, trigger: "manual" } as BusEvent, off)).toBe(true);
    expect(emailsEvent({ ...success, trigger: "webhook" } as BusEvent, off)).toBe(false);
    expect(emailsEvent({ ...success, trigger: "webhook" } as BusEvent, { categories: { deploySuccess: true } })).toBe(true);
  });

  it("emails a restart only when it didn't recover", () => {
    const restart = { type: "app.auto-restarted", title: "", message: "", appId: "a", appName: "api", containerName: "c", containerId: "c", reason: "unhealthy" };
    expect(emailsEvent({ ...restart, success: true, gaveUp: false } as BusEvent, off)).toBe(false);
    expect(emailsEvent({ ...restart, success: false, gaveUp: false } as BusEvent, off)).toBe(true);
    expect(emailsEvent({ ...restart, success: true, gaveUp: true } as BusEvent, off)).toBe(true);
  });
});
