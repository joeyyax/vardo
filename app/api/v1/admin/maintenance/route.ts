import { NextResponse } from "next/server";
import { execSync } from "child_process";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance");

type ServiceStatus = {
  name: string;
  containerId: string;
  status: string;
  state: string;
  image: string;
};

// GET /api/v1/admin/maintenance
//
// Returns the status of all Vardo stack services by inspecting running containers
// with the "vardo-" name prefix via docker ps.
export async function GET() {
  try {
    await requireAppAdmin();

    const vardoDir = process.env.VARDO_DIR ?? null;
    const services: ServiceStatus[] = [];

    try {
      const output = execSync(
        'docker ps -a --filter "name=vardo-" --format "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.State}}\t{{.Image}}"',
        { timeout: 10000 },
      )
        .toString()
        .trim();

      if (output) {
        for (const line of output.split("\n")) {
          const [containerId, name, status, state, image] = line.split("\t");
          if (containerId && name) {
            services.push({ containerId, name, status, state, image });
          }
        }
      }
    } catch (err) {
      log.error(`Failed to query docker ps: ${err}`);
    }

    return NextResponse.json({ services, vardoDir });
  } catch (error) {
    return handleRouteError(error);
  }
}
