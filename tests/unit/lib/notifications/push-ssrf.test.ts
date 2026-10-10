import { describe, it, expect, vi } from "vitest";
import { EMAIL_FIXTURES } from "@/lib/email/fixtures";

// The real outbound guard runs here: a user-supplied ntfy server can't reach internal addresses.

vi.mock("@/lib/security/outbound-policy", () => ({ getOutboundPolicy: async () => ({ allowlist: [] }) }));
vi.mock("@/lib/security/pinned-fetch", () => ({
  pinnedFetch: vi.fn(async () => new Response("{}", { status: 200 })),
}));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "node-a" }));
vi.mock("@/lib/time-zone-settings", () => ({ getOrgTimeZone: async () => "UTC" }));

const { NtfyNotificationChannel } = await import("@/lib/notifications/ntfy-channel");
const { pinnedFetch } = await import("@/lib/security/pinned-fetch");

const event = EMAIL_FIXTURES.find((f) => f.name === "deploy-failed-build")!.event;

describe("ntfy server guard", () => {
  it.each(["http://127.0.0.1:8080", "http://169.254.169.254", "http://10.0.0.5", "http://[::1]"])("refuses %s", async (serverUrl) => {
    const err = await new NtfyNotificationChannel({ topic: "t", serverUrl }).send(event).catch((e) => e);
    expect(err.message).toMatch(/^ntfy request failed:/);
    expect(pinnedFetch).not.toHaveBeenCalled();
  });

  it("reaches a public server", async () => {
    await new NtfyNotificationChannel({ topic: "t", serverUrl: "https://93.184.216.34" }).send(event);
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
  });
});
