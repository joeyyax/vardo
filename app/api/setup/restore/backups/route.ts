import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { needsSetup } from "@/lib/setup";
import { listSystemBackups } from "@/lib/restore/source";
import { resolveTarget, storageErrorMessage, targetBodySchema } from "@/lib/restore/request";
import { apiError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";

// POST /api/setup/restore/backups — system backups in the target. Fresh installs only.
async function handler(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  if (!(await needsSetup())) return apiError.forbidden();

  const parsed = targetBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError.validation(parsed.error);

  const target = await resolveTarget(parsed.data.target);
  if (!target) return NextResponse.json({ error: "Enter the backup storage first." }, { status: 400 });

  try {
    const found = await listSystemBackups(target);
    return NextResponse.json({
      backups: found.map((b) => ({ key: b.key, takenAt: b.takenAt.toISOString(), sizeBytes: b.sizeBytes })),
    });
  } catch (err) {
    return NextResponse.json({ error: storageErrorMessage(err) }, { status: 502 });
  }
}

export const POST = withRateLimit(handler, { tier: "admin", key: "setup-restore-backups" });
