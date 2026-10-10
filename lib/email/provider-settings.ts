import { z } from "zod";
import { getEmailProviderConfig, setSystemSetting } from "@/lib/system-settings";
import { maskSecret, resolveSecret } from "@/lib/mask-secrets";
import { isSmtpAllowed } from "@/lib/config/provider-restrictions";

// The instance's email provider, read masked and saved write-only. Shared by /api/setup/email and the MCP tools.

export const EMAIL_PROVIDERS = ["smtp", "mailpace", "resend", "postmark", "pouch"] as const;

export const emailSettingsSchema = z.object({
  provider: z.enum(EMAIL_PROVIDERS),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().positive().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  apiKey: z.string().optional(),
  fromEmail: z.string().email("Invalid from email"),
  fromName: z.string().optional(),
  baseUrl: z.union([z.literal(""), z.string().url("Invalid base URL")]).optional(),
  webhookSecret: z.string().optional(),
}).strict();

export type EmailSettingsInput = z.infer<typeof emailSettingsSchema>;

/** The stored settings with every secret masked. */
export async function readEmailSettings() {
  const config = await getEmailProviderConfig();
  if (!config) return { configured: false as const, allowSmtp: isSmtpAllowed() };
  return {
    configured: true as const,
    allowSmtp: isSmtpAllowed(),
    provider: config.provider,
    smtpHost: config.smtpHost ?? null,
    smtpPort: config.smtpPort ?? null,
    smtpUser: config.smtpUser ?? null,
    smtpPass: maskSecret(config.smtpPass),
    apiKey: maskSecret(config.apiKey),
    fromEmail: config.fromEmail ?? null,
    fromName: config.fromName ?? null,
    baseUrl: config.baseUrl ?? null,
    webhookSecret: maskSecret(config.webhookSecret),
  };
}

/** Saves the settings. A masked secret keeps the stored one. Returns an error message or null. */
export async function saveEmailSettings(input: EmailSettingsInput): Promise<string | null> {
  const { provider, smtpHost, smtpPort, smtpUser, smtpPass, apiKey, fromEmail, fromName, baseUrl, webhookSecret } = input;
  if (provider === "smtp" && !isSmtpAllowed()) return "SMTP isn't available on this instance";

  const isPouch = provider === "pouch";
  const existing = await getEmailProviderConfig();
  await setSystemSetting("email_provider", JSON.stringify({
    provider,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass: resolveSecret(smtpPass, existing?.smtpPass),
    apiKey: resolveSecret(apiKey, existing?.apiKey),
    fromEmail,
    fromName,
    baseUrl: isPouch ? baseUrl || undefined : undefined,
    webhookSecret: isPouch ? resolveSecret(webhookSecret, existing?.webhookSecret) || undefined : undefined,
  }));
  return null;
}
