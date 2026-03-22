import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getGitHubAppConfig } from "@/lib/system-settings";
import { maskSecret, isMasked } from "@/lib/mask-secrets";

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getGitHubAppConfig();
  if (!config) {
    return NextResponse.json({ configured: false });
  }

  return NextResponse.json({
    configured: true,
    appId: config.appId,
    appSlug: config.appSlug,
    clientId: config.clientId,
    clientSecret: maskSecret(config.clientSecret),
    privateKey: maskSecret(config.privateKey),
    webhookSecret: maskSecret(config.webhookSecret),
  });
}

export async function POST(request: NextRequest) {
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const { appId, appSlug, clientId, clientSecret, privateKey, webhookSecret } = body;

  const existing = await getGitHubAppConfig();

  const config = encryptSystem(JSON.stringify({
    appId,
    appSlug,
    clientId,
    clientSecret: isMasked(clientSecret) ? existing?.clientSecret : clientSecret,
    privateKey: isMasked(privateKey) ? existing?.privateKey : privateKey,
    webhookSecret: isMasked(webhookSecret) ? existing?.webhookSecret : webhookSecret,
  }));

  await db
    .insert(systemSettings)
    .values({ key: "github_app", value: config })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: config, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
