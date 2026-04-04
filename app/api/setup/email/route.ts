import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { getEmailProviderConfig, setSystemSetting } from "@/lib/system-settings";
import { maskSecret, resolveSecret } from "@/lib/mask-secrets";
import { isSmtpAllowed } from "@/lib/config/provider-restrictions";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const emailSchema = z.object({
  provider: z.enum(["smtp", "mailpace", "resend", "postmark"]),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().positive().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  apiKey: z.string().optional(),
  fromEmail: z.string().email("Invalid from email"),
  fromName: z.string().optional(),
}).strict();

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getEmailProviderConfig();
  if (!config) {
    return NextResponse.json({ configured: false, allowSmtp: isSmtpAllowed() });
  }

  return NextResponse.json({
    configured: true,
    allowSmtp: isSmtpAllowed(),
    provider: config.provider,
    smtpHost: config.smtpHost ?? null,
    smtpPort: config.smtpPort ?? null,
    smtpUser: config.smtpUser ?? null,
    smtpPass: maskSecret(config.smtpPass),
    apiKey: maskSecret(config.apiKey),
    fromEmail: config.fromEmail ?? null,
    fromName: config.fromName ?? null,
  });
}

async function handlePost(request: NextRequest) {
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const parsed = emailSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { provider, smtpHost, smtpPort, smtpUser, smtpPass, apiKey, fromEmail, fromName } = parsed.data;

  // Reject SMTP if restricted by deployment config
  if (provider === "smtp" && !isSmtpAllowed()) {
    return NextResponse.json(
      { error: "SMTP is not available on this instance" },
      { status: 403 },
    );
  }

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
  }));

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-email" });
