import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { hostname } from "os";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { logger } from "@/lib/logger";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const log = logger.child("admin:restart");

// POST /api/v1/admin/restart
//
// Restarts the Vardo container. Requires app admin.
//
// Container identity: reads CONTAINER_ID env var first (set this explicitly if
// the container runs with a custom hostname), falls back to os.hostname() which
// matches Docker's default naming scheme. The value is passed as a positional
// arg to `docker restart` — not interpolated into a shell string.
async function handlePost() {
  try {
    await requireAppAdmin();

    // CONTAINER_ID lets operators override the default hostname-based lookup.
    // Useful when the container is started with a custom --hostname or hostname: key.
    const containerId = process.env.CONTAINER_ID ?? hostname();

    setTimeout(() => {
      log.info(`restarting container: ${containerId}`);
      spawn("docker", ["restart", containerId], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }, 2000);

    return NextResponse.json({ success: true, message: "Restarting in 2 seconds..." });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-restart" });
