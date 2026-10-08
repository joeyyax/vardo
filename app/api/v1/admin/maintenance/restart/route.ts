import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { restartSchema } from "@/lib/api/admin/maintenance-schemas";
import { logger } from "@/lib/logger";
import { resolveVardoComposeFile } from "@/lib/paths";
import { dockerEnv } from "@/lib/docker/docker-env";

const log = logger.child("admin:maintenance:restart");

// POST /api/v1/admin/maintenance/restart — recreates one or all stack services with `docker compose up -d`.
// Body: { service?: string }. Omit service to restart all.
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json().catch(() => ({}));
    const parsed = restartSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const { service } = parsed.data;

    const composeFile = resolveVardoComposeFile();
    const args = ["compose", "-f", composeFile, "up", "-d"];
    if (service) {
      args.push("--no-deps", service);
    }

    log.info(`restarting ${service ?? "all services"} via docker compose up -d`);

    setTimeout(() => {
      spawn("docker", args, {
        env: dockerEnv(),
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
