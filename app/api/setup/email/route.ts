import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getEmailProviderConfig } from "@/lib/system-settings";
import { maskSecret, isMasked } from "@/lib/mask-secrets";

const emailSchema = z.object({
  provider: z.enum(["smtp", "mailpace", "resend"]),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().positive().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  apiKey: z.string().optional(),
  fromEmail: z.string().email("Invalid from email"),
  fromName: z.string().optional(),
});

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

  // Keep secrets the user didn't change (sentinel-prefixed values).
  // Empty/null means the user cleared the field intentionally.
  const existing = await getEmailProviderConfig();

  function resolveSecret(incoming: string | undefined | null, existingVal: string | undefined | null): string | undefined {
    if (isMasked(incoming)) return existingVal ?? undefined;
    return incoming ?? undefined;
  }

  const config = encryptSystem(JSON.stringify({
    provider,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass: resolveSecret(smtpPass, existing?.smtpPass),
    apiKey: resolveSecret(apiKey, existing?.apiKey),
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
