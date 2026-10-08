import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { currentRestore, deferApp, moveAppToFront } from "@/lib/restore/queue";
import { kickRestoreWorker } from "@/lib/restore/worker";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";

const bodySchema = z.object({ action: z.enum(["front", "defer", "requeue"]) });

// POST /api/setup/restore/apps/[appId] — reorder or defer a queued app.
async function handler(request: NextRequest, { params }: { params: Promise<{ appId: string }> }) {
  try {
    await requireAdminAuth(request);
    const { appId } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError.validation(parsed.error);

    const run = await currentRestore();
    if (!run) return apiError.notFound("restore");

    const { action } = parsed.data;
    const changed =
      action === "front"
        ? await moveAppToFront(run.id, appId)
        : await deferApp(run.id, appId, action === "defer");
    if (!changed) {
      return NextResponse.json({ error: "Only a queued or deferred app can be moved." }, { status: 409 });
    }
    if (action !== "defer") kickRestoreWorker();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error updating the restore queue");
  }
}

export const POST = withRateLimit(handler, { tier: "admin", key: "setup-restore-app" });
