import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:restart");

// POST /api/v1/admin/maintenance/restart
//
// Restart Vardo stack services. Requires VARDO_DIR env var.
// Body: { service?: string } - if omitted, restarts all services.
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const vardoDir = process.env.VARDO_DIR;
    if (!vardoDir) {
      return NextResponse.json(
        { error: "VARDO_DIR not configured. Stack management requires the Vardo directory to be mounted." },
        { status: 500 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const service = body.service as string | undefined;

    const composePath = `${vardoDir}/docker-compose.yml`;

    // Build command args
    const args = ["compose", "-f", composePath, "up", "-d"];
    if (service) {
      args.push(service);
    }

    log.info("restarting services", { service: service || "all", composePath });

    // Run docker compose up -d [service] in background after a brief delay
    // so the response can be sent before the restart potentially affects this container
    setTimeout(() => {
      const proc = spawn("docker", args, {
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
    }, 1000);

    return NextResponse.json({
      success: true,
      message: service
        ? `Restarting ${service} in 1 second...`
        : "Restarting all services in 1 second...",
    });
  } catch (error) {
    return handleRouteError(error, "Error restarting services");
  }
}
