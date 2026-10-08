import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";
import { requireAppAdmin } from "@/lib/auth/admin";
import {
  readSystemBackupJob,
  readSystemBackupStorage,
  saveSystemBackupStorage,
  SystemStorageConflict,
  systemStorageSchema,
} from "@/lib/backups/system-storage";

// GET /api/v1/admin/system-backup — storage, the database job and its recent runs
async function handleGet() {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    await requireAppAdmin();

    const [storage, { job, history }] = await Promise.all([
      readSystemBackupStorage(),
      readSystemBackupJob(),
    ]);
    return NextResponse.json({ storage, job, history });
  } catch (error) {
    return handleRouteError(error, "Error reading system backup");
  }
}

// PUT /api/v1/admin/system-backup — set system backup storage. A masked or absent secret keeps the stored one.
async function handlePut(request: NextRequest) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    await requireAppAdmin();

    const parsed = systemStorageSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });

    try {
      await saveSystemBackupStorage(parsed.data);
    } catch (err) {
      if (err instanceof SystemStorageConflict) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error saving system backup storage");
  }
}

export const PUT = withRateLimit(handlePut, { tier: "admin", key: "admin-system-backup" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/system-backup" });
