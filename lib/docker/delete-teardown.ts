// Leftovers `compose down` misses when an app is deleted: stopped containers, their networks, an unowned app dir.

import { lstat } from "fs/promises";
import { sep } from "path";
import { dockerRequest, removeContainer } from "./client";
import { APP_UID, DOCKER_CLEANUP_TIMEOUT } from "./constants";
import { dockerEnv } from "./docker-env";
import { execFileAsync } from "@/lib/utils/exec";
import { PROJECTS_DIR } from "@/lib/paths";

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

type RawContainer = { Id: string; Names?: string[]; Labels?: Record<string, string> | null };

function labelQuery(label: string, extra: Record<string, unknown> = {}): string {
  return encodeURIComponent(JSON.stringify({ label: [label], ...extra }));
}

/** Remove every container labeled with these app ids, in any state, then the networks of their compose projects. */
export async function removeAppContainersAndNetworks(
  appIds: string[],
): Promise<{ containers: string[]; networks: string[]; log: string[] }> {
  const log: string[] = [];
  const containers: string[] = [];
  const networks: string[] = [];
  const projects = new Set<string>();

  for (const appId of new Set(appIds)) {
    const found = await dockerRequest<RawContainer[]>(
      "GET",
      `/containers/json?all=true&filters=${labelQuery(`vardo.project.id=${appId}`)}`,
    ).catch((err) => {
      log.push(`Could not list containers for ${appId}: ${errText(err)}`);
      return [] as RawContainer[];
    });

    for (const c of found) {
      const name = c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
      const project = c.Labels?.[COMPOSE_PROJECT_LABEL];
      if (project) projects.add(project);
      try {
        await removeContainer(c.Id, { force: true });
        containers.push(name);
        log.push(`Removed container ${name}`);
      } catch (err) {
        log.push(`Kept container ${name} (removal failed: ${errText(err)})`);
      }
    }
  }

  for (const project of projects) {
    const found = await dockerRequest<{ Id: string; Name: string }[]>(
      "GET",
      `/networks?filters=${labelQuery(`${COMPOSE_PROJECT_LABEL}=${project}`)}`,
    ).catch(() => [] as { Id: string; Name: string }[]);

    for (const n of found) {
      try {
        await dockerRequest("DELETE", `/networks/${encodeURIComponent(n.Id)}`);
        networks.push(n.Name);
        log.push(`Removed network ${n.Name}`);
      } catch (err) {
        log.push(`Kept network ${n.Name} (removal failed: ${errText(err)})`);
      }
    }
  }

  return { containers, networks, log };
}

/** Whether an error means the process lacks permission, not that the path is missing. */
export function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Hand an app directory's top level to the Vardo uid so it can be unlinked. Non-recursive.
 * Refuses anything outside PROJECTS_DIR and symlinks. Returns false when it could not.
 */
export async function claimAppDirTopLevel(dir: string): Promise<boolean> {
  if (!dir.startsWith(PROJECTS_DIR + sep)) return false;
  try {
    if (!(await lstat(dir)).isDirectory()) return false;
    await execFileAsync(
      "docker",
      ["run", "--rm", "-v", `${dir}:/target`, "alpine", "chown", `${APP_UID}:${APP_UID}`, "/target"],
      { env: dockerEnv(), timeout: DOCKER_CLEANUP_TIMEOUT },
    );
    return true;
  } catch {
    return false;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
