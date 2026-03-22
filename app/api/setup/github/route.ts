import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getGitHubAppConfig } from "@/lib/system-settings";
import { maskSecret, isMasked } from "@/lib/mask-secrets";

const githubSchema = z.object({
  appId: z.string().min(1, "App ID is required"),
  appSlug: z.string().min(1, "App slug is required"),
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().optional(),
  privateKey: z.string().optional(),
  webhookSecret: z.string().optional(),
});

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
  const parsed = githubSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { appId, appSlug, clientId, clientSecret, privateKey, webhookSecret } = parsed.data;

  const existing = await getGitHubAppConfig();

  function resolveSecret(incoming: string | undefined | null, existingVal: string | undefined | null): string | undefined {
    if (isMasked(incoming)) return existingVal ?? undefined;
    return incoming ?? undefined;
  }

  const config = encryptSystem(JSON.stringify({
    appId,
    appSlug,
    clientId,
    clientSecret: resolveSecret(clientSecret, existing?.clientSecret),
    privateKey: resolveSecret(privateKey, existing?.privateKey),
    webhookSecret: resolveSecret(webhookSecret, existing?.webhookSecret),
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
