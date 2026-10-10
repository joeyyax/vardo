import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { join } from "path";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { logger } from "@/lib/logger";
import { isSelfDeployLayout, VARDO_HOME_DIR } from "@/lib/paths";
import { triggerSelfDeploy } from "@/lib/lifecycle/deploy-request";

const log = logger.child("admin:maintenance:update");

// POST /api/v1/admin/maintenance/update — redeploys the `vardo` app, or runs install.sh update on a legacy install.
async function handlePost(_request: NextRequest) {
  try {
    const session = await requireAppAdmin();

    if (isSelfDeployLayout()) {
      const { deploymentId } = await triggerSelfDeploy({ triggeredBy: session.user.id });
      log.info(`redeploying Vardo as ${deploymentId}`);
      return NextResponse.json({ ok: true, deploymentId, message: "Redeploying Vardo." });
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
