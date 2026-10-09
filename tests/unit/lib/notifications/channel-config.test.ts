// Channel URLs and signing secrets are encrypted at rest, decrypted to send and
// masked as before in API responses.

import { describe, it, expect, vi } from "vitest";

process.env.ENCRYPTION_MASTER_KEY ??= "b".repeat(64);

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { encrypt, decrypt, isEncrypted } = await import("@/lib/crypto/encrypt");
const {
  sealChannelConfig,
  openChannelConfig,
  presentChannel,
  plaintextChannelSecretKeys,
  ChannelDecryptError,
} = await import("@/lib/notifications/channel-config");
const { restoreMaskedConfig } = await import("@/lib/notifications/mask-config");
const { createChannel } = await import("@/lib/notifications/factory");
const { WebhookNotificationChannel } = await import("@/lib/notifications/webhook-channel");

const ORG = "org-1";
const webhook = { url: "https://hooks.example/x", secret: "whsec_abcd1234" };

describe("sealChannelConfig", () => {
  it("encrypts URLs and secrets under the org key and leaves the rest", () => {
    const sealed = sealChannelConfig({ ...webhook, extra: "keep" }, ORG);
    expect(decrypt(sealed.url, ORG)).toBe(webhook.url);
    expect(decrypt(sealed.secret, ORG)).toBe(webhook.secret);
    expect(sealed.extra).toBe("keep");
    expect(plaintextChannelSecretKeys(sealed)).toEqual([]);
  });

  it("leaves email recipients alone", () => {
    const config = { recipients: ["a@example.com"] };
    expect(sealChannelConfig(config, ORG)).toEqual(config);
  });

  it("doesn't encrypt twice", () => {
    const sealed = sealChannelConfig({ webhookUrl: "https://hooks.slack.com/x" }, ORG);
    expect(sealChannelConfig(sealed, ORG)).toEqual(sealed);
  });
});

describe("openChannelConfig", () => {
  it("decrypts sealed fields", () => {
    const config = sealChannelConfig(webhook, ORG);
    expect(openChannelConfig({ organizationId: ORG, config })).toEqual(webhook);
  });

  it("passes legacy plaintext through", () => {
    expect(openChannelConfig({ organizationId: ORG, config: webhook })).toEqual(webhook);
    expect(plaintextChannelSecretKeys(webhook)).toEqual(["url", "secret"]);
  });

  it("throws when a field won't decrypt", () => {
    const config = { url: encrypt(webhook.url, "another-org") };
    expect(() => openChannelConfig({ name: "Ops", organizationId: ORG, config })).toThrow(ChannelDecryptError);
  });

  it("feeds plaintext to the channel the factory builds", () => {
    const channel = createChannel({ type: "webhook", organizationId: ORG, config: sealChannelConfig(webhook, ORG) });
    expect(channel).toBeInstanceOf(WebhookNotificationChannel);
    expect((channel as unknown as { config: typeof webhook }).config).toEqual(webhook);
  });
});

describe("presentChannel", () => {
  it("masks the webhook URL and secret, never ciphertext", () => {
    const row = { type: "webhook", organizationId: ORG, config: sealChannelConfig(webhook, ORG) };
    expect(presentChannel(row).config).toEqual({ url: "****", secret: "****1234" });
  });

  it("masks a Discord webhook URL", () => {
    const url = "https://discord.com/api/webhooks/123/tok_en";
    const row = { type: "webhook", organizationId: ORG, config: sealChannelConfig({ url }, ORG) };
    expect(presentChannel(row).config).toEqual({ url: "****" });
  });

  it("masks a Slack webhook URL", () => {
    const row = { type: "slack", organizationId: ORG, config: sealChannelConfig({ webhookUrl: "https://hooks.slack.com/x" }, ORG) };
    expect(presentChannel(row).config).toEqual({ webhookUrl: "****" });
  });

  it("masks legacy plaintext the same way", () => {
    expect(presentChannel({ type: "webhook", organizationId: ORG, config: webhook }).config).toEqual({
      url: "****",
      secret: "****1234",
    });
  });

  it("shows no ciphertext when a field won't decrypt", () => {
    const row = { type: "webhook", organizationId: ORG, config: { url: encrypt(webhook.url, "another-org") } };
    const { config } = presentChannel(row) as { config: { url: string } };
    expect(isEncrypted(config.url)).toBe(false);
    expect(config.url).toBe("");
  });
});

describe("restoreMaskedConfig", () => {
  it("keeps the stored URL and secret when the client sends masks back", () => {
    const stored = { url: "https://discord.com/api/webhooks/1/tok", secret: "whsec_abcd1234" };
    expect(restoreMaskedConfig({ url: "****", secret: "****1234" }, stored)).toEqual(stored);
    expect(restoreMaskedConfig({ webhookUrl: "****" }, { webhookUrl: "https://hooks.slack.com/x" })).toEqual({
      webhookUrl: "https://hooks.slack.com/x",
    });
  });

  it("takes a new value over the stored one", () => {
    expect(restoreMaskedConfig({ url: "https://new.example/h", secret: "****1234" }, { url: "https://old/h", secret: "s3cret" })).toEqual({
      url: "https://new.example/h",
      secret: "s3cret",
    });
  });
});
