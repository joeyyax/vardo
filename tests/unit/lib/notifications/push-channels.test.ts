import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES } from "@/lib/email/fixtures";

// Each push channel posts one request through the outbound guard and reports what the provider answered.

const h = vi.hoisted(() => ({
  calls: [] as { url: string; init: RequestInit & { policy?: unknown } }[],
  reply: (() => new Response("{}", { status: 200 })) as () => Response,
}));

vi.mock("@/lib/security/safe-fetch", () => ({
  safeFetch: async (url: string, init: RequestInit) => {
    h.calls.push({ url, init });
    return h.reply();
  },
}));
vi.mock("@/lib/security/outbound-policy", () => ({ getOutboundPolicy: async () => ({ allowlist: [] }) }));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "node-a" }));
vi.mock("@/lib/time-zone-settings", () => ({ getOrgTimeZone: async () => "UTC" }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: async () => ({ categories: {} }) }));
vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://vardo.example.com");

const { NtfyNotificationChannel, ntfyBody } = await import("@/lib/notifications/ntfy-channel");
const { DiscordNotificationChannel } = await import("@/lib/notifications/discord-channel");
const { TelegramNotificationChannel, escapeMarkdownV2 } = await import("@/lib/notifications/telegram-channel");
const { PushoverNotificationChannel } = await import("@/lib/notifications/pushover-channel");
const { ProviderError } = await import("@/lib/notifications/provider-http");

const fixture = (name: string) => EMAIL_FIXTURES.find((f) => f.name === name)!.event;
const failed = fixture("deploy-failed-build");
const warning = fixture("alert-host-disk");
const success = fixture("deploy-success");
const body = (i = 0) => JSON.parse(h.calls[i].init.body as string);
const reply = (status: number, json: unknown) => (h.reply = () => new Response(JSON.stringify(json), { status }));

const NTFY = { topic: "vardo-test", accessToken: "tk_fake0000example" };
const DISCORD = { webhookUrl: "https://discord.com/api/webhooks/123456789012345678/fakeTokenExample_-0" };
const TELEGRAM = { botToken: "123456789:AAFakeTokenExampleFakeToken_0123456", chatId: "-1001234567890" };
const PUSHOVER = { userKey: "u".repeat(30), appToken: "a".repeat(30) };

beforeEach(() => {
  h.calls.length = 0;
  reply(200, {});
});

describe("ntfy", () => {
  it("publishes a titled message with priority, emoji tag, click URL and Markdown", async () => {
    reply(200, { id: "abc123" });
    const receipt = await new NtfyNotificationChannel(NTFY, "org_1").send(failed);
    expect(receipt).toEqual({ providerStatus: 200, providerMessageIds: ["abc123"] });
    expect(h.calls[0].url).toBe("https://ntfy.sh/");
    expect(body()).toMatchObject({
      topic: "vardo-test",
      title: "node-a · ✗ Shop Staging failed at build",
      priority: 5,
      tags: ["rocket"],
      markdown: true,
      click: expect.stringMatching(/^https:\/\/vardo\.example\.com\/apps\/\S+\/deployments$/),
    });
    expect(body().message.split("\n")[0]).not.toBe("");
    expect(body().actions[0]).toMatchObject({ action: "view", url: body().click });
  });

  it("maps warnings to 4 and everything else to 3", async () => {
    await new NtfyNotificationChannel(NTFY).send(warning);
    await new NtfyNotificationChannel(NTFY).send(success);
    await new NtfyNotificationChannel(NTFY).send({ type: "notification.test", title: "t", message: "m", channelName: "c", organizationId: "o" });
    expect(h.calls.map((_, i) => body(i).priority)).toEqual([4, 3]);
  });

  it("links a deploy to the console's deployment tab, not the app's domain", async () => {
    await new NtfyNotificationChannel(NTFY).send({ ...success, trigger: "manual" } as BusEvent);
    expect(body().click).toMatch(/^https:\/\/vardo\.example\.com\/apps\//);
  });

  it("authenticates with a bearer token or basic auth", async () => {
    await new NtfyNotificationChannel(NTFY).send(failed);
    await new NtfyNotificationChannel({ topic: "t", username: "user", password: "pass" }).send(failed);
    await new NtfyNotificationChannel({ topic: "t" }).send(failed);
    const auth = (i: number) => (h.calls[i].init.headers as Record<string, string>).Authorization;
    expect(auth(0)).toBe("Bearer tk_fake0000example");
    expect(auth(1)).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    expect(auth(2)).toBeUndefined();
  });

  it("publishes to a self-hosted server and leaves Markdown off when asked", async () => {
    await new NtfyNotificationChannel({ topic: "t", serverUrl: "https://ntfy.example.com/", markdown: false }).send(failed);
    expect(h.calls[0].url).toBe("https://ntfy.example.com/");
    expect(body()).not.toHaveProperty("markdown");
    expect(body().message).not.toContain("**");
  });

  it("throws with the status and no credentials when the server refuses", async () => {
    reply(401, { error: "unauthorized: tk_fake0000example is not valid" });
    const err = await new NtfyNotificationChannel(NTFY).send(failed).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.providerStatus).toBe(401);
    expect(err.message).toBe("ntfy answered 401: unauthorized: **** is not valid");
  });

  it("puts a one-line summary first and escapes Markdown in event text", () => {
    const text = ntfyBody(
      { title: "t", summary: "my_app_name is *down*", severity: "info", facts: [{ label: "App", value: "a_b" }], instanceName: "n", eventType: "cron.failed", emoji: "x" },
      true,
    );
    expect(text).toBe("my\\_app\\_name is \\*down\\*\n\n**App:** a\\_b");
  });

  it("stays quiet for events the delivery policy leaves to the digest", async () => {
    await expect(new NtfyNotificationChannel(NTFY, "org_1").send(success)).resolves.toEqual({});
    expect(h.calls).toHaveLength(0);
  });

  it("sends a run summary, which email batches", async () => {
    await new NtfyNotificationChannel(NTFY, "org_1").send(fixture("backup-summary"));
    expect(h.calls).toHaveLength(1);
  });
});

describe("Discord", () => {
  it("posts one embed colored by severity, with a title link and fields", async () => {
    reply(200, { id: "1100" });
    const receipt = await new DiscordNotificationChannel(DISCORD).send(failed);
    expect(receipt).toEqual({ providerStatus: 200, providerMessageIds: ["1100"] });
    expect(h.calls[0].url).toBe(`${DISCORD.webhookUrl}?wait=true`);
    const [embed] = body().embeds;
    expect(embed).toMatchObject({
      title: "node-a · ✗ Shop Staging failed at build",
      color: 0xe5484d,
      url: expect.stringMatching(/^https:\/\/vardo\.example\.com\/apps\//),
      footer: { text: "node-a · deploy.failed" },
    });
    expect(embed.description).toMatch(/\[Open deployment log\]\(https:\/\/vardo\.example\.com\//);
    expect(embed.fields.length).toBeGreaterThan(0);
    expect(embed.fields[0]).toEqual({ name: expect.any(String), value: expect.any(String), inline: expect.any(Boolean) });
  });

  it("colors warnings amber and never pings anyone", async () => {
    await new DiscordNotificationChannel(DISCORD).send(warning);
    expect(body().embeds[0].color).toBe(0xf5a524);
    expect(body().allowed_mentions).toEqual({ parse: [] });
  });

  it("refuses a URL that isn't a Discord webhook, without sending", async () => {
    await expect(new DiscordNotificationChannel({ webhookUrl: "https://discord.com.evil.example.com/api/webhooks/1/x" }).send(failed)).rejects.toThrow(
      "isn't a Discord webhook",
    );
    expect(h.calls).toHaveLength(0);
  });

  it("hides the token when Discord refuses", async () => {
    reply(404, { message: "Unknown Webhook fakeTokenExample_-0" });
    const err = await new DiscordNotificationChannel(DISCORD).send(failed).catch((e) => e);
    expect(err.message).toBe("Discord answered 404: Unknown Webhook ****");
  });
});

describe("Telegram", () => {
  it("sends MarkdownV2 with a bold title, escaped text and a link", async () => {
    reply(200, { ok: true, result: { message_id: 42 } });
    const receipt = await new TelegramNotificationChannel(TELEGRAM).send(failed);
    expect(receipt).toEqual({ providerStatus: 200, providerMessageIds: ["42"] });
    expect(h.calls[0].url).toBe(`https://api.telegram.org/bot${TELEGRAM.botToken}/sendMessage`);
    expect(body()).toMatchObject({ chat_id: "-1001234567890", parse_mode: "MarkdownV2", disable_notification: false });
    expect(body().text.startsWith("*node\\-a · ✗ Shop Staging failed at build*\n\n")).toBe(true);
    expect(body().text).toMatch(/\[Open deployment log\]\(https:\/\/vardo\.example\.com\/apps\/[^)]+\)$/);
  });

  it("escapes every reserved character", () => {
    expect(escapeMarkdownV2("_*[]()~`>#+-=|{}.!\\")).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\");
    expect(escapeMarkdownV2("a_b (v1.2)")).toBe("a\\_b \\(v1\\.2\\)");
  });

  it("makes quiet messages silent", async () => {
    await new TelegramNotificationChannel(TELEGRAM).send({ type: "notification.test", title: "t", message: "Hello", channelName: "c", organizationId: "o" });
    expect(body().disable_notification).toBe(true);
  });

  it("throws when Telegram answers ok:false or an error status, without the bot token", async () => {
    reply(400, { ok: false, description: "Bad Request: chat not found" });
    await expect(new TelegramNotificationChannel(TELEGRAM).send(failed)).rejects.toThrow("Telegram answered 400: Bad Request: chat not found");
    reply(200, { ok: false, description: "nope" });
    await expect(new TelegramNotificationChannel(TELEGRAM).send(failed)).rejects.toThrow("Telegram refused the message: nope");
    h.reply = () => {
      throw new Error(`connect ECONNREFUSED /bot${TELEGRAM.botToken}/sendMessage`);
    };
    const err = await new TelegramNotificationChannel(TELEGRAM).send(failed).catch((e) => e);
    expect(err.message).not.toContain(TELEGRAM.botToken);
    expect(err.message).toContain("/bot****/sendMessage");
  });
});

describe("Pushover", () => {
  it("maps severity to priority and links to the console", async () => {
    reply(200, { status: 1, request: "req-1" });
    const receipt = await new PushoverNotificationChannel(PUSHOVER).send(failed);
    expect(receipt).toEqual({ providerStatus: 200, providerMessageIds: ["req-1"] });
    expect(h.calls[0].url).toBe("https://api.pushover.net/1/messages.json");
    expect(body()).toMatchObject({
      token: PUSHOVER.appToken,
      user: PUSHOVER.userKey,
      title: "node-a · ✗ Shop Staging failed at build",
      priority: 1,
      url_title: "Open deployment log",
    });
    await new PushoverNotificationChannel(PUSHOVER).send(warning);
    await new PushoverNotificationChannel(PUSHOVER).send({ type: "notification.test", title: "t", message: "m", channelName: "c", organizationId: "o" });
    expect([1, 2].map((i) => body(i).priority)).toEqual([0, -1]);
  });

  it("keeps the message within Pushover's limit", async () => {
    await new PushoverNotificationChannel(PUSHOVER).send({ ...failed, message: "x".repeat(5000) } as BusEvent);
    expect(body().message.length).toBeLessThanOrEqual(1024);
  });

  it("throws on an error status or status:0, without the keys", async () => {
    reply(400, { status: 0, errors: [`user identifier ${PUSHOVER.userKey} is invalid`] });
    const err = await new PushoverNotificationChannel(PUSHOVER).send(failed).catch((e) => e);
    expect(err.message).toBe("Pushover answered 400: user identifier **** is invalid");
    expect(err.providerStatus).toBe(400);
    reply(200, { status: 0, errors: ["nope"] });
    await expect(new PushoverNotificationChannel(PUSHOVER).send(failed)).rejects.toThrow("Pushover refused the message: nope");
  });
});

describe("outbound guard", () => {
  it("sends every request through safeFetch with the outbound policy", async () => {
    await new NtfyNotificationChannel(NTFY).send(failed);
    expect(h.calls[0].init.policy).toEqual({ allowlist: [] });
  });
});
