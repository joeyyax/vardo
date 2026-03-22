import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";

export async function POST(request: Request) {
  // Only accessible during setup or by admin
  const setup = await needsSetup();
  if (!setup) {
    await requireSession();
  }

  const body = await request.json();
  const { provider, smtpHost, smtpPort, smtpUser, smtpPass, apiKey, fromEmail, fromName } = body;

  const config = JSON.stringify({
    provider, // "smtp" | "resend"
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    apiKey,
    fromEmail,
    fromName,
  });

  await db
    .insert(systemSettings)
    .values({ key: "email_provider", value: config })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: config, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
