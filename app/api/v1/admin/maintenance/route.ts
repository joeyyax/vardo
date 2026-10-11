import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { stackServices, type StackContainer, type StackService } from "@/lib/docker/stack-services";

const log = logger.child("admin:maintenance");

async function ownProject(): Promise<string | null> {
  try {
    const { hostname } = await import("os");
    const { inspectContainer } = await import("@/lib/docker/client");
    const info = await inspectContainer(process.env.CONTAINER_ID ?? hostname());
    return info.labels["com.docker.compose.project"] ?? null;
  } catch {
    return null;
  }
}

// GET /api/v1/admin/maintenance — status of the vardo-* stack containers.
async function handleGet() {
  try {
    await requireAppAdmin();

    const hasVardoDir = !!(process.env.VARDO_HOME_DIR || process.env.VARDO_DIR);
    const rows: StackContainer[] = [];
    let services: StackService[] = [];

    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["ps", "-a", "--filter", "name=vardo-", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.State}}\t{{.Image}}\t{{.Label \"com.docker.compose.project\"}}"],
        { env: dockerEnv(), timeout: 10000 },
      );

      const output = stdout.trim();
      if (output) {
        for (const line of output.split("\n")) {
          const [containerId, name, status, state, image, project = ""] = line.split("\t");
          if (containerId && name) {
            rows.push({ containerId, name, status, state, image, project });
          }
        }
      }
      services = stackServices(rows, await ownProject());
    } catch (err) {
      log.error(`Failed to query docker ps: ${err}`);
    }

    return NextResponse.json({ services, hasVardoDir });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/maintenance" });
