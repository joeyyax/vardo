import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";

export async function POST(request: NextRequest) {
  // Only accessible during initial setup or by an app admin
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const { provider, smtpHost, smtpPort, smtpUser, smtpPass, apiKey, fromEmail, fromName } = body;

  const config = encryptSystem(JSON.stringify({
    provider, // "smtp" | "resend"
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    apiKey,
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
