import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// POST /api/v1/organizations/[orgId]/notifications/[channelId]/test

const h = vi.hoisted(() => ({
  access: null as unknown,
  channel: null as unknown,
  result: { ok: true, message: "Sent.", providerStatus: 200 } as Record<string, unknown>,
  sentTo: [] as unknown[],
}));

vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: async () => h.access }));
vi.mock("@/lib/notifications/channels", () => ({ findChannel: async () => h.channel }));
vi.mock("@/lib/notifications/test-send", () => ({
  sendTestNotification: async (channel: unknown) => {
    h.sentTo.push(channel);
    return h.result;
  },
}));

const { POST } = await import("@/app/api/v1/organizations/[orgId]/notifications/[channelId]/test/route");

const call = () =>
  POST(new NextRequest("http://localhost/api/v1/organizations/org-1/notifications/c1/test", { method: "POST" }), {
    params: Promise.resolve({ orgId: "org-1", channelId: "c1" }),
  });

beforeEach(() => {
  h.access = { session: { user: { id: "u1" } } };
  h.channel = { id: "c1", organizationId: "org-1", name: "Ops", type: "webhook", config: {} };
  h.result = { ok: true, message: "Sent.", providerStatus: 200 };
  h.sentTo.length = 0;
});

describe("notification channel test send", () => {
  it("refuses without notifications access", async () => {
    h.access = null;
    expect((await call()).status).toBe(403);
    expect(h.sentTo).toHaveLength(0);
  });

  it("404s a channel outside the org", async () => {
    h.channel = undefined;
    expect((await call()).status).toBe(404);
  });

  it("returns the provider result", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: "Sent.", providerStatus: 200 });
  });

  it("answers 502 when the provider refused", async () => {
    h.result = { ok: false, message: "The endpoint answered 500.", providerStatus: 500 };
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, providerStatus: 500 });
  });
});
