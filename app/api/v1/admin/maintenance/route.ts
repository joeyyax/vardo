import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance");

type ContainerInfo = {
  name: string;
  status: string;
  health: string | null;
  uptime: string | null;
};

// GET /api/v1/admin/maintenance
//
// List all Vardo stack containers with status, health, and uptime.
// Filters by com.docker.compose.project=vardo label.
export async function GET() {
  try {
    await requireAppAdmin();

    // Use Docker API via socket to list containers
    const { spawn } = await import("child_process");

    const containers = await new Promise<ContainerInfo[]>((resolve, reject) => {
      const proc = spawn("docker", [
        "ps",
        "-a",
        "--filter", "label=com.docker.compose.project=vardo",
        "--format", "{{json .}}",
      ]);

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data; });
      proc.stderr.on("data", (data) => { stderr += data; });

      proc.on("close", (code) => {
        if (code !== 0) {
          log.error("docker ps failed", { code, stderr });
          reject(new Error(`docker ps failed: ${stderr}`));
          return;
        }

        const lines = stdout.trim().split("\n").filter(Boolean);
        const result: ContainerInfo[] = [];

        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            // Extract health from status string (e.g., "Up 2 hours (healthy)")
            const statusMatch = json.Status?.match(/\((\w+)\)$/);
            const health = statusMatch?.[1] || null;

            // Extract uptime from status
            const uptimeMatch = json.Status?.match(/^Up\s+(.+?)(?:\s+\(|$)/);
            const uptime = uptimeMatch?.[1] || null;

            result.push({
              name: json.Names || json.Name,
              status: json.State || (json.Status?.startsWith("Up") ? "running" : "stopped"),
              health,
              uptime,
            });
          } catch {
            // Skip malformed lines
          }
        }

        resolve(result);
      });
    });

    return NextResponse.json({ containers });
  } catch (error) {
    return handleRouteError(error, "Error listing Vardo containers");
  }
}
