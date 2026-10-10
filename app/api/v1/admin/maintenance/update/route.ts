import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { join } from "path";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { logger } from "@/lib/logger";
import { isSelfDeployLayout, VARDO_HOME_DIR } from "@/lib/paths";
import { effectiveChannel } from "@/lib/self-update/policy";
import { startUpdate, UpdateBlockedError } from "@/lib/self-update/runner";
import { getUpdatePolicy } from "@/lib/self-update/store";
import { getChannelUpdate } from "@/lib/version";

const log = logger.child("admin:maintenance:update");

// POST /api/v1/admin/maintenance/update — Update now: dumps the database and redeploys the `vardo` app on the policy's
// channel, then verifies it. A legacy install runs install.sh update.
async function handlePost(_request: NextRequest) {
  try {
    const session = await requireAppAdmin();

    if (isSelfDeployLayout()) {
      const channel = effectiveChannel(await getUpdatePolicy());
      try {
        const run = await startUpdate({
          trigger: "manual",
          triggeredBy: session.user.id,
          channel,
          update: await getChannelUpdate(channel),
        });
        log.info(`redeploying Vardo as ${run.deploymentId}`);
        return NextResponse.json({ ok: true, deploymentId: run.deploymentId, message: `Updating Vardo to ${run.toLabel}.` });
      } catch (err) {
        if (err instanceof UpdateBlockedError) return NextResponse.json({ error: err.message }, { status: 409 });
        throw err;
      }
    }

    const installScript = join(VARDO_HOME_DIR, "install.sh");

    log.info("triggering install.sh update in background");

    setTimeout(() => {
      const update = spawn(
        "bash",
        [installScript, "update", "--yes"],
        { detached: true, stdio: "ignore", cwd: VARDO_HOME_DIR },
      );
      update.unref();
    }, 500);

    return NextResponse.json({
      ok: true,
      message: "Update initiated — blue/green deploy running in the background.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "critical", key: "maintenance:update" });
