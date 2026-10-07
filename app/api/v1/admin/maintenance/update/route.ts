import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { join } from "path";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { logger } from "@/lib/logger";
import { VARDO_HOME_DIR } from "@/lib/paths";

const log = logger.child("admin:maintenance:update");

// POST /api/v1/admin/maintenance/update — runs install.sh update on the host, detached.
// install.sh handles the blue/green swap. The API returns immediately.
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
