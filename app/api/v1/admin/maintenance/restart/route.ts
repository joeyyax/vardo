import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { restartSchema } from "@/lib/api/admin/maintenance-schemas";
import { logger } from "@/lib/logger";
import { resolveVardoComposeFile } from "@/lib/paths";
import { dockerEnv } from "@/lib/docker/docker-env";
import { FRONTEND_SERVICE, SHARED_PROJECT, composeIdentity, restartArgs, sharedServices } from "./plan";

const log = logger.child("admin:maintenance:restart");

// POST /api/v1/admin/maintenance/restart — recreates one or all shared stack services in project `vardo`.
// Body: { service?: string } (a container name). The frontend runs in a slot project and updates through /update.
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
    let services: string[];
    if (service) {
      const identity = await composeIdentity(service);
      if (!identity) return apiError.notFound("service");
      if (identity.project !== SHARED_PROJECT || identity.service === FRONTEND_SERVICE) {
        return NextResponse.json(
          { error: `${service} isn't restarted here. Use Update to redeploy the frontend.` },
          { status: 409 },
        );
      }
      services = [identity.service];
    } else {
      services = await sharedServices(composeFile);
    }
    const args = restartArgs(composeFile, services);

    log.info(`restarting ${service ?? "all services"} in project ${SHARED_PROJECT}`);

    setTimeout(() => {
      spawn("docker", args, {
        env: dockerEnv(),
        detached: true,
        stdio: "ignore",
      }).unref();
    }, 1000);

    return NextResponse.json({
      ok: true,
      message: service ? `Restarting ${service}...` : "Restarting shared services...",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "critical", key: "maintenance:restart" });
