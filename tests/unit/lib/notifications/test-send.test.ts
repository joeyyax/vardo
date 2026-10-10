import { describe, it, expect, vi, beforeEach } from "vitest";

// A test send goes through the real channel and reports what the provider said.

const h = vi.hoisted(() => ({
  sent: [] as unknown[],
  reply: (async () => ({})) as () => Promise<unknown>,
}));
vi.mock("@/lib/notifications/factory", () => ({
  createChannel: () => ({
    send: (event: unknown) => {
      h.sent.push(event);
      return h.reply();
    },
  }),
}));

import { sendTestNotification } from "@/lib/notifications/test-send";

const channel = { name: "Ops", type: "webhook" as const, organizationId: "org-1", config: {} };
const replyWith = (value: unknown) => (h.reply = async () => value);

beforeEach(() => {
  h.sent.length = 0;
});

describe("sendTestNotification", () => {
  it("sends an event labeled as a test", async () => {
    replyWith({ providerStatus: 204 });
    await sendTestNotification(channel);
    expect(h.sent).toEqual([
      expect.objectContaining({ type: "notification.test", title: "Test notification from Vardo", channelName: "Ops" }),
    ]);
  });

  it("reports a 2xx as delivered, with the status", async () => {
    replyWith({ providerStatus: 200 });
    expect(await sendTestNotification(channel)).toEqual({ ok: true, message: "Sent.", providerStatus: 200 });
  });

  it("reports a non-2xx as a failure", async () => {
    replyWith({ providerStatus: 404 });
    expect(await sendTestNotification(channel)).toEqual({
      ok: false,
      message: "The endpoint answered 404.",
      providerStatus: 404,
    });
  });

  it("passes email message IDs and partial failures through", async () => {
    replyWith({ providerMessageIds: ["m1"], partialFailure: "Not sent to 1 of 2: b@example.com: rejected" });
    expect(await sendTestNotification({ ...channel, type: "email" })).toMatchObject({
      ok: true,
      message: "Sent, but not to every recipient.",
      providerMessageIds: ["m1"],
    });
  });

  it("reports a thrown send as a failure with its message", async () => {
    h.reply = async () => {
      throw new Error("Email not sent to any recipient. a@example.com: rejected");
    };
    expect(await sendTestNotification({ ...channel, type: "email" })).toEqual({
      ok: false,
      message: "Email not sent to any recipient. a@example.com: rejected",
    });
  });
});
