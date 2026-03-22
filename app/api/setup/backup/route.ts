import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { db } from "@/lib/db";
import { systemSettings } from "@/lib/db/schema";
import { encryptSystem } from "@/lib/crypto/encrypt";
import { getBackupStorageConfig } from "@/lib/system-settings";
import { maskSecret, isMasked } from "@/lib/mask-secrets";

const backupSchema = z.object({
  type: z.enum(["s3", "r2", "b2"]),
  bucket: z.string().min(1, "Bucket name is required"),
  region: z.string().min(1, "Region is required"),
  endpoint: z.string().optional(),
  accessKey: z.string().optional(),
  secretKey: z.string().optional(),
});

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
  const parsed = backupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { type, bucket, region, endpoint, accessKey, secretKey } = parsed.data;

  const existing = await getBackupStorageConfig();

  function resolveSecret(incoming: string | undefined | null, existingVal: string | undefined | null): string | undefined {
    if (isMasked(incoming)) return existingVal ?? undefined;
    return incoming ?? undefined;
  }

  const config = encryptSystem(JSON.stringify({
    type,
    bucket,
    region,
    endpoint,
    accessKey: resolveSecret(accessKey, existing?.accessKey),
    secretKey: resolveSecret(secretKey, existing?.secretKey),
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
