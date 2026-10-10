// Config shape and validation for each channel type.

import { z } from "zod";
import type { ChannelType } from "./channel-types";

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

const DISCORD_HOSTS = new Set(["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"]);
const DISCORD_PATH = /^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/;

/** The parsed URL when it's a Discord webhook endpoint over https, else null. */
export function parseDiscordWebhook(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!DISCORD_HOSTS.has(url.hostname.toLowerCase()) || !DISCORD_PATH.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** An ntfy server URL without a trailing slash, or null when it isn't a plain http(s) URL. */
export function normalizeNtfyServer(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    if (url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

const ntfyServer = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const raw = v?.trim();
    if (!raw) return DEFAULT_NTFY_SERVER;
    const server = normalizeNtfyServer(raw);
    if (!server) {
      ctx.addIssue({ code: "custom", message: "Must be an http(s) URL without credentials or a query string" });
      return z.NEVER;
    }
    return server;
  });

const emailSchema = z.object({ recipients: z.array(z.string().email()).min(1) });
const webhookSchema = z.object({ url: z.string().url(), secret: z.string().optional() });
const slackSchema = z.object({ webhookUrl: z.string().url() });

const ntfySchema = z
  .object({
    serverUrl: ntfyServer,
    topic: z.string().trim().regex(/^[-_A-Za-z0-9]{1,64}$/, "Use 1-64 letters, digits, dashes or underscores"),
    accessToken: z.string().trim().min(1).optional(),
    username: z.string().trim().min(1).optional(),
    password: z.string().min(1).optional(),
    markdown: z.boolean().optional(),
  })
  .refine((c) => !(c.accessToken && (c.username || c.password)), {
    message: "Use an access token or a username and password, not both",
    path: ["accessToken"],
  })
  .refine((c) => Boolean(c.username) === Boolean(c.password), {
    message: "Username and password go together",
    path: ["password"],
  });

const discordSchema = z.object({
  webhookUrl: z
    .string()
    .trim()
    .refine((v) => parseDiscordWebhook(v) !== null, {
      message: "Must be a Discord webhook URL: https://discord.com/api/webhooks/<id>/<token>",
    }),
});

const telegramSchema = z.object({
  botToken: z.string().trim().regex(/^\d{5,}:[\w-]{20,}$/, "Looks like 123456789:AA..."),
  chatId: z
    .string()
    .trim()
    .regex(/^(-?\d{1,20}|@[A-Za-z]\w{4,31})$/, "A number such as -1001234567890, or @channelname"),
});

const pushoverSchema = z.object({
  userKey: z.string().trim().regex(/^[A-Za-z0-9]{30}$/, "Must be 30 letters and digits"),
  appToken: z.string().trim().regex(/^[A-Za-z0-9]{30}$/, "Must be 30 letters and digits"),
});

export const CONFIG_SCHEMAS = {
  email: emailSchema,
  webhook: webhookSchema,
  slack: slackSchema,
  ntfy: ntfySchema,
  discord: discordSchema,
  telegram: telegramSchema,
  pushover: pushoverSchema,
} satisfies Record<ChannelType, z.ZodType>;

const FIELD_LABELS: Record<string, string> = {
  recipients: "Recipients",
  url: "URL",
  serverUrl: "Server URL",
  topic: "Topic",
  accessToken: "Access token",
  username: "Username",
  password: "Password",
  webhookUrl: "Webhook URL",
  botToken: "Bot token",
  chatId: "Chat ID",
  userKey: "User key",
  appToken: "App token",
};

export type ChannelConfigResult = { ok: true; config: Record<string, unknown> } | { ok: false; error: string };

/** Validates and normalizes a config for its type. The error names the first problem. */
export function parseChannelConfig(type: ChannelType, config: unknown): ChannelConfigResult {
  const result = CONFIG_SCHEMAS[type].safeParse(config);
  if (result.success) return { ok: true, config: result.data as Record<string, unknown> };
  const issue = result.error.issues[0];
  const key = String(issue?.path.at(-1) ?? "");
  const label = FIELD_LABELS[key];
  const message = issue?.message.endsWith("received undefined") ? "Required" : (issue?.message ?? "Invalid config");
  return { ok: false, error: label ? `${label}: ${message.charAt(0).toLowerCase()}${message.slice(1)}` : message };
}
