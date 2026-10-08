import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { needsSetup } from "@/lib/setup";
import { checkSystemBackup } from "@/lib/restore/source";
import { keyBodySchema, resolveTarget, storageErrorMessage } from "@/lib/restore/request";
import { apiError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";

// POST /api/setup/restore/check — compare Key IDs, then the auth secret, with the backup. Restores nothing.
async function handler(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  if (!(await needsSetup())) return apiError.forbidden();

  const parsed = keyBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError.validation(parsed.error);

  const target = await resolveTarget(parsed.data.target);
  if (!target) return NextResponse.json({ error: "Enter the backup storage first." }, { status: 400 });

  try {
    return NextResponse.json(await checkSystemBackup(target, parsed.data.backupKey, parsed.data.masterKey));
  } catch (err) {
    return NextResponse.json({ error: storageErrorMessage(err) }, { status: 502 });
  }
}

export const POST = withRateLimit(handler, { tier: "admin", key: "setup-restore-check" });
