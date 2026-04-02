import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { join } from "path";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { logger } from "@/lib/logger";
import { VARDO_HOME_DIR } from "@/lib/paths";

const log = logger.child("admin:maintenance:update");

// POST /api/v1/admin/maintenance/update
//
// Delegates to install.sh update running on the host. install.sh handles
// the full blue/green update cycle: pull into inactive slot, build, health
// check, swap the current symlink, and stop the old slot. The API returns
// immediately — the update runs detached in the background.
async function handlePost(_request: NextRequest) {
  try {
    await requireAppAdmin();

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
