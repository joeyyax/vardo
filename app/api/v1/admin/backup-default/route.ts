import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAppAdmin } from "@/lib/auth/admin";
import { getSystemBackupsDefault, reconcileInBackground, setSystemBackupsDefault } from "@/lib/backups/switch";

// GET /api/v1/admin/backup-default
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json({ enabled: await getSystemBackupsDefault() });
  } catch (error) {
    return handleRouteError(error, "Error reading backup default");
  }
}

const putSchema = z.object({ enabled: z.boolean() }).strict();

// PUT /api/v1/admin/backup-default
async function handlePut(request: NextRequest) {
  try {
    await requireAppAdmin();

    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    await setSystemBackupsDefault(parsed.data.enabled);
    reconcileInBackground({ inheritOnly: true, orgInheritOnly: true, reenable: true });

    return NextResponse.json({ enabled: parsed.data.enabled });
  } catch (error) {
    return handleRouteError(error, "Error changing backup default");
  }
}

export const PUT = withRateLimit(handlePut, { tier: "admin", key: "admin-backup-default" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/backup-default" });
