import { describe, it, expect } from "vitest";
import type { BusEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { pushMessageFor } from "@/lib/notifications/push-message";

const ctx = { ...FIXTURE_CONTEXT, baseUrl: "https://vardo.example.com" };
const message = (name: string) => pushMessageFor(EMAIL_FIXTURES.find((f) => f.name === name)!.event, ctx)!;

describe("pushMessageFor", () => {
  it("leads with the instance and the state, like the email subject", () => {
    expect(message("deploy-success").title).toBe("node-a · ✓ acme-web deployed · a1b2c3d");
    expect(message("deploy-failed-build").title).toBe("node-a · ✗ Shop Staging failed at build");
  });

  it("gives a one-line summary", () => {
    for (const { name } of EMAIL_FIXTURES) {
      const msg = pushMessageFor(EMAIL_FIXTURES.find((f) => f.name === name)!.event, ctx);
      if (!msg) continue;
      expect(msg.summary, name).not.toMatch(/\n/);
      expect(msg.summary.length, name).toBeLessThanOrEqual(160);
      expect(msg.title.length, name).toBeLessThanOrEqual(120);
    }
  });

  it("reads severity from the email's tone", () => {
    expect(message("deploy-failed-build").severity).toBe("critical");
    expect(message("alert-host-disk").severity).toBe("warning");
    expect(message("deploy-success").severity).toBe("success");
    expect(message("alert-resolved").severity).toBe("success");
  });

  it("links to a console tab, never the app's own domain", () => {
    expect(message("deploy-success").url).toMatch(/^https:\/\/vardo\.example\.com\/apps\/\S+\/deployments$/);
    expect(message("deploy-failed-build").url).toMatch(/^https:\/\/vardo\.example\.com\/apps\/\S+\/deployments$/);
    for (const { event } of EMAIL_FIXTURES) {
      const msg = pushMessageFor(event, ctx);
      if (msg) expect(msg.url, event.type).toMatch(/^https:\/\/vardo\.example\.com(\/|$)/);
    }
  });

  it("uses the tab the email's link names", () => {
    expect(message("security-scan-batch").url).toMatch(/\/security$/);
    expect(message("cron-failed").url).toMatch(/\/cron$/);
  });

  it("returns null for events that never notify", () => {
    const progress = { type: "backup.progress", title: "t", message: "m", jobId: "j", jobName: "n", appId: null, appName: "a", volumeName: "v", index: 1, total: 2 } as BusEvent;
    expect(pushMessageFor(progress, ctx)).toBeNull();
  });

  it("caps the facts", () => {
    for (const { event } of EMAIL_FIXTURES) expect(pushMessageFor(event, ctx)?.facts.length ?? 0).toBeLessThanOrEqual(6);
  });
});
