// ---------------------------------------------------------------------------
// Bind-mount ownership prep (issue #738)
//
// When a compose service bind-mounts a host path that doesn't exist yet, the
// Docker daemon creates that host directory as root:root. A service running as
// a non-root user (compose `user:` or the image's `USER`) then can't write
// under the mount — the runtime bind shadows the image's own chowned directory.
//
// Before `docker compose up`, we resolve each service's non-root uid and chown
// any freshly-created bind-mount target to it. Vardo itself runs non-root and
// can't chown arbitrary host paths, so the chown goes through a one-shot
// container (the same pattern as constants.ts `ensureWritableDir`).
//
// PR #727's entrypoint self-heal only covers Vardo's own data dirs; this covers
// user bind-mount targets.
// ---------------------------------------------------------------------------

import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";

import { DOCKER_CHOWN_TIMEOUT, COMPOSE_QUERY_TIMEOUT } from "../constants";
import type { ComposeService } from "../compose-types";
import type { DeployContext } from "../deploy-context";

const execFileAsync = promisify(execFile);

/**
 * Resolve a compose volume entry to its absolute host bind-mount source, or
 * null when it isn't a bind mount (named or anonymous volume).
 *
 * `cwd` is the slot dir `docker compose up` runs from, so relative sources
 * resolve to the same path Docker will use.
 */
export function bindMountHostSource(vol: string, cwd: string): string | null {
  // Mirror compose-validate's isBindMount: a bare absolute path with no colon
  // (e.g. "/data") is an anonymous volume, not a bind mount.
  const isBind =
    vol.startsWith("./") ||
    vol.startsWith("../") ||
    (vol.startsWith("/") && vol.includes(":"));
  if (!isBind) return null;
  const rawSource = vol.split(":")[0];
  return resolve(cwd, rawSource);
}

/**
 * Parse the uid out of a user spec ("1000", "1000:1000", "appuser:appgroup").
 * Returns the numeric uid string, or null when the user part is a name (digits
 * only counts) and must be resolved against the image's passwd.
 */
export function numericUid(spec: string | undefined): string | null {
  if (!spec) return null;
  const uidPart = spec.split(":")[0].trim();
  return /^\d+$/.test(uidPart) ? uidPart : null;
}

/** Read the image's configured USER via `docker image inspect`. */
async function inspectImageUser(image: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["image", "inspect", "--format", "{{.Config.User}}", image],
      { timeout: COMPOSE_QUERY_TIMEOUT },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a named user to its uid inside the image (`id -u <name>`). */
async function resolveUidInImage(image: string, name: string): Promise<string | null> {
  try {
    const userPart = name.split(":")[0];
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "--entrypoint", "id", image, "-u", userPart],
      { timeout: COMPOSE_QUERY_TIMEOUT },
    );
    const uid = stdout.trim();
    return /^\d+$/.test(uid) && uid !== "0" ? uid : null;
  } catch {
    return null;
  }
}

/**
 * Determine the non-root uid a service's main process runs as, or null when it
 * runs as root / can't be determined — in which case a root-owned host dir is
 * already correct and there's nothing to fix.
 */
async function resolveServiceUid(svc: ComposeService): Promise<string | null> {
  // An explicit compose `user:` overrides the image's USER, so it wins.
  const composeUser = svc.user?.trim();
  if (composeUser) {
    const num = numericUid(composeUser);
    if (num !== null) return num === "0" ? null : num;
    return svc.image ? resolveUidInImage(svc.image, composeUser) : null;
  }

  // No compose user — fall back to the image's configured USER.
  if (!svc.image) return null; // build-only service, no user: → assume root
  const imageUser = await inspectImageUser(svc.image);
  const num = numericUid(imageUser);
  if (num !== null) return num === "0" ? null : num;
  return imageUser ? resolveUidInImage(svc.image, imageUser) : null;
}

/**
 * Chown a bind-mount target to `uid` — but only when the directory is empty, so
 * a freshly-created mount target gets fixed while a pre-existing directory with
 * the user's data is never touched. Best-effort: logs and continues on error.
 *
 * Mounting a missing host path makes the Docker daemon create it root-owned;
 * the container then chowns it from the inside (where it runs as root).
 */
async function chownIfEmpty(
  hostPath: string,
  uid: string,
  service: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${hostPath}:/target`,
        "alpine",
        "sh",
        "-c",
        // uid is validated numeric; hostPath only appears in the -v arg (its own
        // argv slot), never in the shell string — no injection surface here.
        `[ -z "$(ls -A /target 2>/dev/null)" ] && chown ${uid} /target || true`,
      ],
      { timeout: DOCKER_CHOWN_TIMEOUT },
    );
    log(`[deploy] Prepared bind-mount target for ${service}: ${hostPath} (uid ${uid})`);
  } catch (err) {
    log(
      `[deploy] Warning: could not prepare bind-mount ownership for ${hostPath} — ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Pre-create and chown bind-mount targets to each service's non-root uid before
 * `docker compose up`, so non-root containers can write under freshly-created
 * host paths. No-op when bind mounts aren't allowed (they're stripped from the
 * compose file in that case, so there are no host paths to prepare).
 */
export async function prepareBindMountOwnership(ctx: DeployContext): Promise<void> {
  if (!ctx.projectAllowBindMounts) return;
  const { compose, slotDir, log } = ctx;

  const chowned = new Set<string>();
  for (const [name, svc] of Object.entries(compose.services)) {
    const binds = (svc.volumes ?? [])
      .map((v) => bindMountHostSource(v, slotDir))
      .filter((p): p is string => p !== null);
    if (binds.length === 0) continue;

    const uid = await resolveServiceUid(svc).catch(() => null);
    if (!uid) continue; // runs as root or undeterminable — root-owned is fine

    for (const hostPath of binds) {
      if (chowned.has(hostPath)) continue;
      chowned.add(hostPath);
      await chownIfEmpty(hostPath, uid, name, log);
    }
  }
}
