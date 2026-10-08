import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { hostname } from "os";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { logger } from "@/lib/logger";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { dockerEnv } from "@/lib/docker/docker-env";

const log = logger.child("admin:restart");

// POST /api/v1/admin/restart — restarts the Vardo container. Requires app admin.
// The container ID is a positional arg to `docker restart`, never interpolated into a shell string.
async function handlePost() {
  try {
    await requireAppAdmin();

    // CONTAINER_ID overrides the hostname-based lookup.
    const containerId = process.env.CONTAINER_ID ?? hostname();

    setTimeout(() => {
      log.info(`restarting container: ${containerId}`);
      spawn("docker", ["restart", containerId], {
        env: dockerEnv(),
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
