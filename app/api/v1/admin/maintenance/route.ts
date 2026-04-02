import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

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

    const hasVardoDir = !!(process.env.VARDO_HOME_DIR || process.env.VARDO_DIR);
    const services: ServiceStatus[] = [];

    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["ps", "-a", "--filter", "name=vardo-", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.State}}\t{{.Image}}"],
        { timeout: 10000 },
      );

      const output = stdout.trim();
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

    return NextResponse.json({ services, hasVardoDir });
  } catch (error) {
    return handleRouteError(error);
  }
}
