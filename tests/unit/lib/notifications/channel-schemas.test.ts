import { describe, it, expect } from "vitest";
import { parseChannelConfig, parseDiscordWebhook, normalizeNtfyServer } from "@/lib/notifications/channel-schemas";

const discord = "https://discord.com/api/webhooks/123456789012345678/fakeTokenExample_-0";

describe("ntfy config", () => {
  it("defaults the server to ntfy.sh", () => {
    expect(parseChannelConfig("ntfy", { topic: "vardo-test" })).toEqual({
      ok: true,
      config: { serverUrl: "https://ntfy.sh", topic: "vardo-test" },
    });
  });

  it("normalizes the server and keeps auth", () => {
    expect(parseChannelConfig("ntfy", { serverUrl: " https://ntfy.example.com/sub/ ", topic: "t", accessToken: "tk_fake" })).toEqual({
      ok: true,
      config: { serverUrl: "https://ntfy.example.com/sub", topic: "t", accessToken: "tk_fake" },
    });
  });

  it.each([
    [{ topic: "has space" }, /Topic/],
    [{ topic: "" }, /Topic/],
    [{}, /Topic: required/],
    [{ topic: "t", serverUrl: "ftp://ntfy.example.com" }, /Server URL/],
    [{ topic: "t", serverUrl: "https://user:pw@ntfy.example.com" }, /Server URL/],
    [{ topic: "t", accessToken: "tk", username: "u", password: "p" }, /not both/],
    [{ topic: "t", username: "u" }, /go together/],
  ])("rejects %j", (config, message) => {
    const result = parseChannelConfig("ntfy", config);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(message);
  });

  it("only accepts plain http(s) server URLs", () => {
    expect(normalizeNtfyServer("http://ntfy.internal:2586")).toBe("http://ntfy.internal:2586");
    expect(normalizeNtfyServer("https://ntfy.example.com?x=1")).toBeNull();
    expect(normalizeNtfyServer("not a url")).toBeNull();
  });
});

describe("Discord config", () => {
  it("accepts Discord's webhook hosts", () => {
    for (const host of ["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"]) {
      expect(parseChannelConfig("discord", { webhookUrl: discord.replace("discord.com", host) }).ok).toBe(true);
    }
  });

  it.each([
    "https://example.com/api/webhooks/123/abc",
    "https://discord.com.evil.example.com/api/webhooks/123/abc",
    "https://evil.example.com/https://discord.com/api/webhooks/123/abc",
    "http://discord.com/api/webhooks/123/abc",
    "https://user@discord.com/api/webhooks/123/abc",
    "https://discord.com:8443/api/webhooks/123/abc",
    "https://discord.com/api/webhooks/abc",
    "https://discord.com/other",
    "https://hooks.slack.com/services/T/B/x",
  ])("rejects %s", (webhookUrl) => {
    expect(parseDiscordWebhook(webhookUrl)).toBeNull();
    expect(parseChannelConfig("discord", { webhookUrl }).ok).toBe(false);
  });
});

describe("Telegram config", () => {
  const botToken = "123456789:AAFakeTokenExampleFakeToken_0123456";

  it("takes a numeric or @channel chat ID", () => {
    expect(parseChannelConfig("telegram", { botToken, chatId: "-1001234567890" }).ok).toBe(true);
    expect(parseChannelConfig("telegram", { botToken, chatId: "@vardo_alerts" }).ok).toBe(true);
  });

  it.each([
    [{ botToken: "nope", chatId: "1" }, /Bot token/],
    [{ botToken, chatId: "my chat" }, /Chat ID/],
    [{ botToken }, /Chat ID: required/],
  ])("rejects %j", (config, message) => {
    const result = parseChannelConfig("telegram", config);
    expect(result.ok === false && result.error).toMatch(message);
  });
});

describe("Pushover config", () => {
  const key = "k".repeat(30);

  it("needs a 30-character user key and app token", () => {
    expect(parseChannelConfig("pushover", { userKey: key, appToken: key }).ok).toBe(true);
    expect(parseChannelConfig("pushover", { userKey: "short", appToken: key }).ok).toBe(false);
    expect(parseChannelConfig("pushover", { userKey: key }).ok).toBe(false);
  });
});

describe("existing types", () => {
  it("still validate", () => {
    expect(parseChannelConfig("email", { recipients: ["ops@example.com"] }).ok).toBe(true);
    expect(parseChannelConfig("email", { recipients: [] }).ok).toBe(false);
    expect(parseChannelConfig("webhook", { url: "https://example.com/hook", secret: "s" }).ok).toBe(true);
    expect(parseChannelConfig("slack", { webhookUrl: "https://hooks.slack.com/x" }).ok).toBe(true);
    expect(parseChannelConfig("slack", { url: "https://example.com" }).ok).toBe(false);
  });
});
