import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusEvent } from "@/lib/bus/events";

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/email/series", () => ({ loadMailSeries: async () => ({}) }));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "node-a" }));
vi.mock("@/lib/db", () => ({ db: { query: { organizations: { findFirst: async () => ({ name: "Joey Yax" }) } } } }));
vi.mock("@/lib/db/schema", () => ({ organizations: { id: "id" } }));

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
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "a@x.com", subject: "✗ api failed" });
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

  it("sends nothing for UI-only events", async () => {
    const status: BusEvent = { type: "deploy.status", title: "", message: "", appId: "a", deploymentId: "d", status: "running", success: false };
    await expect(channel(["a@x.com"]).send(status)).resolves.toEqual({});
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
