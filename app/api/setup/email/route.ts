import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getEmailProviderConfig } from "@/lib/system-settings";
import { maskSecret, isMasked } from "@/lib/mask-secrets";

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getEmailProviderConfig();
  if (!config) {
    return NextResponse.json({ configured: false });
  }

  return NextResponse.json({
    configured: true,
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

export async function POST(request: NextRequest) {
  // Only accessible during initial setup or by an app admin
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const { provider, smtpHost, smtpPort, smtpUser, smtpPass, apiKey, fromEmail, fromName } = body;

  // Merge with existing config — keep secrets the user didn't change
  const existing = await getEmailProviderConfig();

  const config = encryptSystem(JSON.stringify({
    provider,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass: isMasked(smtpPass) ? existing?.smtpPass : smtpPass,
    apiKey: isMasked(apiKey) ? existing?.apiKey : apiKey,
    fromEmail,
    fromName,
  }));

  await db
    .insert(systemSettings)
    .values({ key: "email_provider", value: config })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: config, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
