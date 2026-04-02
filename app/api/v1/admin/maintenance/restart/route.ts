import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { restartSchema } from "@/lib/api/admin/maintenance-schemas";
import { logger } from "@/lib/logger";
import { VARDO_HOME_DIR } from "@/lib/paths";

const log = logger.child("admin:maintenance:restart");

// POST /api/v1/admin/maintenance/restart
//
// Restarts one or all Vardo stack services via `docker compose up -d`.
// Body: { service?: string } — omit service to restart all services.
//
// Uses docker compose up -d rather than docker restart so that config
// changes and image updates are picked up on recreate.
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json().catch(() => ({}));
    const parsed = restartSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { service } = parsed.data;

    const args = ["compose", "-f", `${VARDO_HOME_DIR}/docker-compose.yml`, "up", "-d"];
    if (service) {
      args.push("--no-deps", service);
    }

    log.info(`restarting ${service ?? "all services"} via docker compose up -d`);

    setTimeout(() => {
      spawn("docker", args, {
        detached: true,
        stdio: "ignore",
      }).unref();
    }, 1000);

    return NextResponse.json({
      ok: true,
      message: service ? `Restarting ${service}...` : "Restarting all services...",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "critical", key: "maintenance:restart" });
