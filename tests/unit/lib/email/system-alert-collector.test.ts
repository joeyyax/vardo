import { describe, it, expect } from "vitest";
import { FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { systemAlertMail } from "@/lib/email/templates/system-alert";

describe("collector outage mail", () => {
  it("says container metrics are paused, with no fallback", () => {
    const mail = systemAlertMail(
      {
        type: "system.service-down",
        title: "Service degraded: Collector",
        message: "Collector (Container and GPU metrics) is no longer responding.",
        service: "Collector",
        description: "Container and GPU metrics",
        latencyMs: "2001",
      },
      FIXTURE_CONTEXT,
    );
    expect(mail.preheader).toBe("Container metrics are paused.");
    expect(JSON.stringify(mail)).not.toMatch(/fall back|fallback|cadvisor/i);
  });
});
