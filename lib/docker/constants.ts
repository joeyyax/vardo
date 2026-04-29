// ---------------------------------------------------------------------------
// Docker orchestration constants
//
// Centralized values that were previously scattered as magic numbers
// throughout deploy.ts and related modules.
// ---------------------------------------------------------------------------

/** UID used for the app user inside containers and on host directories. */
export const APP_UID = process.env.VARDO_APP_UID || "1001";

/** Default container port when none is detected or configured. */
export const DEFAULT_CONTAINER_PORT = 3000;

/** Docker network shared by all deployed apps and Traefik. */
export const NETWORK_NAME = "vardo-network";

// ---------------------------------------------------------------------------
// Timeouts (milliseconds)
// ---------------------------------------------------------------------------

/** Time allowed for a git clone operation. */
export const GIT_CLONE_TIMEOUT = 60_000;

/** Time allowed for a full image build (Nixpacks, Railpack, Dockerfile). */
export const BUILD_TIMEOUT = 300_000;

/** Time allowed for `docker compose up` (standard services). */
export const COMPOSE_UP_TIMEOUT = 120_000;

/** Time allowed for `docker compose up` (compose-type deploys with builds). */
export const COMPOSE_BUILD_UP_TIMEOUT = 600_000;

/** Default health check timeout when the compose file doesn't specify one. */
export const DEFAULT_HEALTH_CHECK_TIMEOUT = 60_000;

/** Post-deploy delay before health re-checks and drift detection. */
export const POST_DEPLOY_DELAY = 10_000;

/** Time allowed for `docker compose down` and `docker compose stop` operations. */
export const COMPOSE_DOWN_TIMEOUT = 30_000;

/** Time allowed for `docker compose restart` / stop+restart / recreate. */
export const COMPOSE_RESTART_TIMEOUT = 60_000;

/** Time allowed for `docker compose logs` and `docker compose ps` queries. */
export const COMPOSE_QUERY_TIMEOUT = 10_000;

/** Time allowed for `docker volume create`. */
export const VOLUME_CREATE_TIMEOUT = 10_000;

/** Time allowed for docker-based chown/cleanup operations on host dirs. */
export const DOCKER_CHOWN_TIMEOUT = 15_000;

/** Time allowed for docker-based rm+chown cleanup (stale repo dirs, volume du). */
export const DOCKER_CLEANUP_TIMEOUT = 30_000;

/** Time allowed for lightweight git metadata commands (rev-parse, log). */
export const GIT_METADATA_TIMEOUT = 5_000;

/** Time allowed for HTTP endpoint check during health verification. */
export const ENDPOINT_CHECK_TIMEOUT = 5_000;

/** Time allowed for HTTP probe abort during container health polling. */
export const HTTP_PROBE_TIMEOUT = 3_000;

/** Time allowed for containers to reach running state during instant rollback. */
export const INSTANT_ROLLBACK_HEALTH_TIMEOUT = 10_000;

/** Polling interval during instant rollback health checks. */
export const INSTANT_ROLLBACK_POLL_INTERVAL = 1_000;

// ---------------------------------------------------------------------------
// Shared deploy utilities
// ---------------------------------------------------------------------------

import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PROJECTS_DIR } from "@/lib/paths";

const execFileAsyncInternal = promisify(execFile);

/**
 * Create a directory and ensure the app user can write to it.
 * If the dir exists but is root-owned, fix ownership via docker.
 */
export async function ensureWritableDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    const probe = join(dir, `.write-probe-${process.pid}`);
    await writeFile(probe, "");
    await rm(probe);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EACCES") {
      if (!dir.startsWith(PROJECTS_DIR + "/")) {
        throw new Error(`Permission denied and path outside apps dir: ${dir}`);
      }
      await execFileAsyncInternal("docker", [
        "run", "--rm", "-v", `${dir}:/target`, "alpine", "chown", "-R", `${APP_UID}:${APP_UID}`, "/target",
      ], { timeout: DOCKER_CHOWN_TIMEOUT });
    } else {
      throw err;
    }
  }
}
