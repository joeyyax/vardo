import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAdminAuth } from "@/lib/auth/admin";
import {
  getBackupEncryptionEnabled,
  setBackupEncryptionEnabled,
} from "@/lib/backups/encryption-setting";

const putSchema = z.object({ enabled: z.boolean() }).strict();

const state = (enabled: boolean) =>
  NextResponse.json({ enabled, keyAvailable: !!process.env.ENCRYPTION_MASTER_KEY });

// GET /api/v1/system/backup-encryption — instance-wide backup encryption setting.
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    return state(await getBackupEncryptionEnabled());
  } catch (error) {
    return handleRouteError(error, "Error reading backup encryption setting");
  }
}

// PUT /api/v1/system/backup-encryption — instance-wide backup encryption setting.
async function handlePut(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    await setBackupEncryptionEnabled(parsed.data.enabled);
    return state(parsed.data.enabled);
  } catch (error) {
    return handleRouteError(error, "Error changing backup encryption setting");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/system/backup-encryption" });
export const PUT = withRateLimit(handlePut, { tier: "admin", key: "admin-backup-encryption" });
