import { NextRequest, NextResponse } from "next/server";
import { needsSetup } from "@/lib/setup";
import { checkBackupKey } from "@/lib/restore/source";
import { keyBodySchema, resolveTarget, storageErrorMessage } from "@/lib/restore/request";
import { apiError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";

// POST /api/setup/restore/check — compare the entered key's Key ID with the backup's. Restores nothing.
async function handler(request: NextRequest) {
  if (!(await needsSetup())) return apiError.forbidden();

  const parsed = keyBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError.validation(parsed.error);

  const target = await resolveTarget(parsed.data.target);
  if (!target) return NextResponse.json({ error: "Enter the backup storage first." }, { status: 400 });

  try {
    return NextResponse.json(await checkBackupKey(target, parsed.data.backupKey, parsed.data.masterKey));
  } catch (err) {
    return NextResponse.json({ error: storageErrorMessage(err) }, { status: 502 });
  }
}

export const POST = withRateLimit(handler, { tier: "admin", key: "setup-restore-check" });
