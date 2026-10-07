import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAppAdmin } from "@/lib/auth/admin";
import { getSystemBackupsDefault, reconcileInBackground, setSystemBackupsDefault } from "@/lib/backups/switch";

// GET /api/v1/admin/backup-default
export async function GET() {
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
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    await setSystemBackupsDefault(parsed.data.enabled);
    reconcileInBackground({ inheritOnly: true, orgInheritOnly: true, reenable: true });

    return NextResponse.json({ enabled: parsed.data.enabled });
  } catch (error) {
    return handleRouteError(error, "Error changing backup default");
  }
}

export const PUT = withRateLimit(handlePut, { tier: "admin", key: "admin-backup-default" });
