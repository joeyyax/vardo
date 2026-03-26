import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { logger } from "@/lib/logger";

const log = logger.child("admin:traefik:restart");

export async function POST(request: NextRequest) {
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
