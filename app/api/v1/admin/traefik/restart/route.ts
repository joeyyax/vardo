import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { logger } from "@/lib/logger";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const log = logger.child("admin:traefik:restart");

async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    log.info("restarting vardo-traefik container");

    spawn("docker", ["restart", "vardo-traefik"], {
      detached: true,
      stdio: "ignore",
    }).unref();

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "traefik-restart" });
