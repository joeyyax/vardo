import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  parsePouchEvent,
  pouchBaseUrl,
  sendViaPouch,
  verifyPouch,
  verifyPouchSignature,
} from "@/lib/email/pouch";
import type { EmailProviderConfig } from "@/lib/system-settings";

const config: EmailProviderConfig = {
  provider: "pouch",
  apiKey: "pk_live_abc",
  fromEmail: "alerts@example.com",
};

const msg = { to: "a@b.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", from: "Vardo <alerts@example.com>" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("pouchBaseUrl", () => {
  it("defaults to pouch.email and trims trailing slashes", () => {
    expect(pouchBaseUrl({})).toBe("https://pouch.email");
    expect(pouchBaseUrl({ baseUrl: "  " })).toBe("https://pouch.email");
    expect(pouchBaseUrl({ baseUrl: "https://mail.internal/" })).toBe("https://mail.internal");
  });
});

describe("sendViaPouch", () => {
  it("posts to /v1/emails with a bearer key and returns the message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "msg_123", status: "queued", warnings: [] }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendViaPouch(config, { ...msg, replyTo: "ops@example.com" });

    expect(result).toEqual({ success: true, messageId: "msg_123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://pouch.email/v1/emails");
    expect(init.headers.Authorization).toBe("Bearer pk_live_abc");
    expect(JSON.parse(init.body)).toMatchObject({ to: "a@b.com", reply_to: "ops@example.com", tags: ["vardo"] });
  });

  it("surfaces Pouch's error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: "recipient_suppressed", message: "a@b.com is suppressed." } }, 422),
    ));
    expect(await sendViaPouch(config, msg)).toEqual({ success: false, error: "Pouch: a@b.com is suppressed." });
  });

  it("refuses without a key", async () => {
    const result = await sendViaPouch({ ...config, apiKey: undefined }, msg);
    expect(result.success).toBe(false);
  });
});

describe("verifyPouch", () => {
  it("passes when the from domain is verified, following pagination", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ name: "other.com", status: "verified" }], next_cursor: "c1" }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ name: "Example.com", status: "verified" }], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyPouch(config);

    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=c1");
  });

  it("fails on a pending domain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ name: "example.com", status: "pending" }], next_cursor: null }),
    ));
    expect(await verifyPouch(config)).toEqual({
      ok: false,
      message: "example.com is pending in Pouch. Finish its DNS setup there.",
    });
  });

  it("fails when the domain is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [], next_cursor: null })));
    expect((await verifyPouch(config)).ok).toBe(false);
  });

  it("reports a rejected key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { code: "invalid_key" } }, 401)));
    expect(await verifyPouch(config)).toEqual({ ok: false, message: "Pouch rejected the API key" });
  });
});

describe("verifyPouchSignature", () => {
  const secret = "whsec_test";
  const body = '{"type":"email.delivered"}';
  const now = 1_760_000_000_000;
  const ts = String(now / 1000);
  const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

  it("accepts a fresh, correctly signed body", () => {
    expect(verifyPouchSignature({ secret, body, signature: sig, timestamp: ts, now })).toBe(true);
  });

  it("rejects a tampered body, a wrong secret or missing headers", () => {
    expect(verifyPouchSignature({ secret, body: body + " ", signature: sig, timestamp: ts, now })).toBe(false);
    expect(verifyPouchSignature({ secret: "other", body, signature: sig, timestamp: ts, now })).toBe(false);
    expect(verifyPouchSignature({ secret, body, signature: null, timestamp: ts, now })).toBe(false);
    expect(verifyPouchSignature({ secret, body, signature: sig, timestamp: null, now })).toBe(false);
  });

  it("rejects a timestamp older than five minutes", () => {
    expect(verifyPouchSignature({ secret, body, signature: sig, timestamp: ts, now: now + 301_000 })).toBe(false);
  });
});

describe("parsePouchEvent", () => {
  it("maps delivery events to statuses", () => {
    expect(parsePouchEvent({ type: "email.bounced", data: { id: "msg_1" } })).toEqual({ messageId: "msg_1", status: "bounced" });
    expect(parsePouchEvent({ type: "email.complained", data: { id: "msg_1" } })?.status).toBe("complained");
    expect(parsePouchEvent({ type: "email.delivered", data: { id: "msg_1" } })?.status).toBe("delivered");
  });

  it("ignores other events and malformed bodies", () => {
    expect(parsePouchEvent({ type: "list.subscribed", data: { id: "lmb_1" } })).toBeNull();
    expect(parsePouchEvent({ type: "email.bounced" })).toBeNull();
    expect(parsePouchEvent(null)).toBeNull();
  });
});
