import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { getBackupStorageConfig } from "@/lib/system-settings";
import { maskSecret } from "@/lib/mask-secrets";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { saveSystemBackupStorage, systemStorageSchema, SystemStorageConflict } from "@/lib/backups/system-storage";

async function handleGet(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  try {
    await requireAdminAuth(request);
  } catch (error) {
    return handleRouteError(error);
  }

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

async function handlePost(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  const setup = await needsSetup();
  if (!setup) {
    try {
      await requireAdminAuth(request);
    } catch (error) {
      return handleRouteError(error);
    }
  }

  const parsed = systemStorageSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError.validation(parsed.error, { details: true });
  }

  try {
    await saveSystemBackupStorage(parsed.data);
  } catch (err) {
    if (err instanceof SystemStorageConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-backup" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/backup" });
