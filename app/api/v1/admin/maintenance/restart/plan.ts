// What "restart" runs. The shared services live in compose project `vardo`; the frontend runs in a slot project.

import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

export const SHARED_PROJECT = "vardo";
export const FRONTEND_SERVICE = "frontend";

const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** `docker compose up -d` arguments for the shared project. Never names the frontend. */
export function restartArgs(composeFile: string, services: string[]): string[] {
  const names = services.filter((s) => s !== FRONTEND_SERVICE && SERVICE_RE.test(s));
  if (names.length === 0) throw new Error("No shared services to restart");
  return ["compose", "-p", SHARED_PROJECT, "-f", composeFile, "up", "-d", "--no-deps", ...names];
}

/** Services the compose file defines for the shared project, with active profiles applied. */
export async function sharedServices(composeFile: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "-p", SHARED_PROJECT, "-f", composeFile, "config", "--services"],
    { env: dockerEnv(), timeout: 15_000 },
  );
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** The compose project and service a container belongs to, or null when it has neither label. */
export async function composeIdentity(container: string): Promise<{ project: string; service: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.service"}}',
        container,
      ],
      { env: dockerEnv(), timeout: 10_000 },
    );
    const [project, service] = stdout.trim().split("\t");
    return project && service ? { project, service } : null;
  } catch {
    return null;
  }
}
