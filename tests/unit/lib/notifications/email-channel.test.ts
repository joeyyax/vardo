import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusEvent } from "@/lib/bus/events";

const { sendEmail, settings } = vi.hoisted(() => ({ sendEmail: vi.fn(), settings: vi.fn() }));

vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/email/series", () => ({ loadMailSeries: async () => ({}) }));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "node-a" }));
vi.mock("@/lib/time-zone-settings", () => ({ getOrgTimeZone: async () => "UTC" }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: settings }));

const { EmailNotificationChannel } = await import("@/lib/notifications/email-channel");

const event: BusEvent = {
  type: "deploy.failed",
  title: "Deploy failed: api",
  message: "Build failed",
  projectName: "api",
  appId: "app_1",
  deploymentId: "dep_1",
  errorMessage: "Build failed",
};

const channel = (recipients: string[]) => new EmailNotificationChannel({ recipients }, "org_1");

// mockClear, not mockReset: vitest 5 fails a test whose reset mock later throws, even when caught.
beforeEach(() => {
  sendEmail.mockClear();
});

describe("EmailNotificationChannel", () => {
  it("returns provider message ids when every send lands", async () => {
    sendEmail.mockResolvedValueOnce({ success: true, messageId: "m1" }).mockResolvedValueOnce({ success: true, messageId: "m2" });
    await expect(channel(["a@x.com", "b@x.com"]).send(event)).resolves.toEqual({ providerMessageIds: ["m1", "m2"] });
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "a@x.com", subject: "node-a · ✗ api failed" });
  });

  it("throws when the provider rejects every recipient, so dispatch retries", async () => {
    sendEmail.mockResolvedValue({ success: false, error: "Pouch: 422 suppressed" });
    await expect(channel(["a@x.com"]).send(event)).rejects.toThrow("a@x.com: Pouch: 422 suppressed");
  });

  it("throws when every send throws", async () => {
    sendEmail.mockImplementation(() => {
      throw new Error("ECONNRESET");
    });
    await expect(channel(["a@x.com", "b@x.com"]).send(event)).rejects.toThrow("Email not sent to any recipient");
  });

  it("reports a partial failure on a send that reached someone", async () => {
    sendEmail.mockResolvedValueOnce({ success: true, messageId: "m1" }).mockResolvedValueOnce({ success: false, error: "Resend: 422" });
    await expect(channel(["a@x.com", "b@x.com"]).send(event)).resolves.toEqual({
      providerMessageIds: ["m1"],
      partialFailure: "Not sent to 1 of 2: b@x.com: Resend: 422",
    });
  });

  it("emails a deploy someone started by hand, and leaves pushes to the digest", async () => {
    sendEmail.mockResolvedValue({ success: true });
    settings.mockResolvedValue({ categories: { deploySuccess: false } });
    const success: BusEvent = { type: "deploy.success", title: "", message: "", projectName: "api", appId: "app_1", deploymentId: "dep_1", duration: "1s" };
    await channel(["a@x.com"]).send({ ...success, trigger: "webhook" });
    expect(sendEmail).not.toHaveBeenCalled();
    await channel(["a@x.com"]).send({ ...success, trigger: "manual" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("emails every successful deploy once the org opts in", async () => {
    sendEmail.mockResolvedValue({ success: true });
    settings.mockResolvedValue({ categories: { deploySuccess: true } });
    const success: BusEvent = { type: "deploy.success", title: "", message: "", projectName: "api", appId: "app_1", deploymentId: "dep_1", duration: "1s", trigger: "api" };
    await channel(["a@x.com"]).send(success);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("leaves a restart that recovered to the digest", async () => {
    const restart: BusEvent = { type: "app.auto-restarted", title: "", message: "", appId: "a", appName: "api", containerName: "c", containerId: "c", reason: "unhealthy", success: true, gaveUp: false };
    await expect(channel(["a@x.com"]).send(restart)).resolves.toEqual({});
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends nothing for UI-only events", async () => {
    const status: BusEvent = { type: "deploy.status", title: "", message: "", appId: "a", deploymentId: "d", status: "running", success: false };
    await expect(channel(["a@x.com"]).send(status)).resolves.toEqual({});
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("threads an incident's emails on its id and leaves one-off emails unthreaded", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://vardo.example.com");
    sendEmail.mockResolvedValue({ success: true });
    const incident = {
      id: "inc_1", key: "app:app_1:deploy.failed", kind: "deploy.failed", state: "open" as const, transition: "updated" as const,
      severity: "critical" as const, peakSeverity: "critical" as const, subject: { type: "app" as const, id: "app_1" }, title: "api failed to deploy",
      openedAt: "2026-10-10T10:00:00.000Z", updatedAt: "2026-10-10T11:00:00.000Z", resolvedAt: null, updates: 1, url: "https://vardo.example.com/apps/app_1",
    };
    await channel(["a@x.com"]).send({ ...event, incident } as BusEvent);
    await channel(["a@x.com"]).send(event);
    expect(sendEmail.mock.calls[0][0].thread).toEqual({ root: "<inc_1@vardo.example.com>", reply: true });
    expect(sendEmail.mock.calls[1][0].thread).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
