import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";

const { getConfig, update, set, where } = vi.hoisted(() => {
  const where = vi.fn(async () => {});
  const set = vi.fn(() => ({ where }));
  return { getConfig: vi.fn(), update: vi.fn(() => ({ set })), set, where };
});

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/system-settings", () => ({ getEmailProviderConfig: getConfig }));
vi.mock("@/lib/db", () => ({ db: { update } }));

import { POST } from "@/app/api/v1/email/pouch/webhook/route";

const SECRET = "whsec_test";

function signedRequest(payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
  return new NextRequest("http://localhost/api/v1/email/pouch/webhook", {
    method: "POST",
    body,
    headers: { "x-signature": sig, "x-timestamp": ts, "content-type": "application/json" },
  });
}

const call = (req: NextRequest) => (POST as unknown as (r: NextRequest) => Promise<Response>)(req);

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue({ provider: "pouch", apiKey: "k", webhookSecret: SECRET });
});

describe("POST /api/v1/email/pouch/webhook", () => {
  it("records a bounce against the matching log rows", async () => {
    const res = await call(signedRequest({ id: "evt_1", type: "email.bounced", data: { id: "msg_1" } }));
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith({ deliveryStatus: "bounced" });
    expect(where).toHaveBeenCalledOnce();
  });

  it("rejects a bad signature", async () => {
    const res = await call(signedRequest({ type: "email.bounced", data: { id: "msg_1" } }, "wrong"));
    expect(res.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("ignores events it doesn't track", async () => {
    const res = await call(signedRequest({ type: "list.subscribed", data: { id: "lmb_1" } }));
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(update).not.toHaveBeenCalled();
  });

  it("answers 404 when Pouch webhooks aren't set up", async () => {
    getConfig.mockResolvedValue({ provider: "resend", apiKey: "k" });
    const res = await call(signedRequest({ type: "email.bounced", data: { id: "msg_1" } }));
    expect(res.status).toBe(404);
  });
});
