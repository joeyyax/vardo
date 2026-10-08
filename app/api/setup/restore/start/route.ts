import { NextRequest, NextResponse } from "next/server";
import { needsSetup } from "@/lib/setup";
import { RestoreRefusedError, startInstanceRestore } from "@/lib/restore/database";
import { RESTORE_COOKIE } from "@/lib/restore/status";
import { keyBodySchema, resolveTarget, storageErrorMessage } from "@/lib/restore/request";
import { apiError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";

// POST /api/setup/restore/start — check the Key ID, then restore Vardo's database and queue the apps.
async function handler(request: NextRequest) {
  if (!(await needsSetup())) return apiError.forbidden();

  const parsed = keyBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError.validation(parsed.error);

  const target = await resolveTarget(parsed.data.target);
  if (!target) return NextResponse.json({ error: "Enter the backup storage first." }, { status: 400 });

  try {
    const { runId, token } = await startInstanceRestore({
      target,
      backupKey: parsed.data.backupKey,
      masterKey: parsed.data.masterKey,
    });
    const response = NextResponse.json({ runId });
    response.cookies.set(RESTORE_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
    return response;
  } catch (err) {
    if (err instanceof RestoreRefusedError) return NextResponse.json({ error: err.message }, { status: 409 });
    return NextResponse.json({ error: storageErrorMessage(err) }, { status: 502 });
  }
}

export const POST = withRateLimit(handler, { tier: "critical", key: "setup-restore-start" });
