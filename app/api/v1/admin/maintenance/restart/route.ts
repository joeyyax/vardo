import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { z } from "zod";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:restart");

const restartSchema = z.object({
  service: z.string().optional(),
});

// POST /api/v1/admin/maintenance/restart
//
// Restarts one or all Vardo stack services via `docker compose up -d`.
// Body: { service?: string } — omit service to restart all services.
//
// Uses docker compose up -d rather than docker restart so that config
// changes and image updates are picked up on recreate.
export async function POST(request: Request) {
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
    const vardoDir = process.env.VARDO_DIR;

    if (!vardoDir) {
      return NextResponse.json(
        { error: "VARDO_DIR is not set — cannot run docker compose without knowing the installation path" },
        { status: 503 },
      );
    }

    const args = ["compose", "-f", `${vardoDir}/docker-compose.yml`, "up", "-d"];
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
