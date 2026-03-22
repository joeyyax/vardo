import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getBackupStorageConfig } from "@/lib/system-settings";
import { maskSecret, isMasked } from "@/lib/mask-secrets";

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getBackupStorageConfig();
  if (!config) {
    return NextResponse.json({ configured: false });
  }

  return NextResponse.json({
    configured: true,
    type: config.type,
    bucket: config.bucket ?? null,
    region: config.region ?? null,
    endpoint: config.endpoint ?? null,
    accessKey: maskSecret(config.accessKey),
    secretKey: maskSecret(config.secretKey),
  });
}

export async function POST(request: NextRequest) {
  const setup = await needsSetup();
  if (!setup) {
    await requireAdminAuth(request);
  }

  const body = await request.json();
  const { type, bucket, region, endpoint, accessKey, secretKey } = body;

  const existing = await getBackupStorageConfig();

  const config = encryptSystem(JSON.stringify({
    type,
    bucket,
    region,
    endpoint,
    accessKey: isMasked(accessKey) ? existing?.accessKey : accessKey,
    secretKey: isMasked(secretKey) ? existing?.secretKey : secretKey,
  }));

  await db
    .insert(systemSettings)
    .values({ key: "backup_storage", value: config })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: config, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
