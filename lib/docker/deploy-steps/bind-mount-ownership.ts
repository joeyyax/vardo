// Chowns freshly created bind-mount targets to the service's non-root uid before `up` (#738).
// Docker creates missing host paths as root:root.

import { resolve } from "path";
import { execFileAsync } from "@/lib/utils/exec";

import { DOCKER_CHOWN_TIMEOUT, COMPOSE_QUERY_TIMEOUT } from "../constants";
import type { ComposeService } from "../compose-types";
import type { DeployContext } from "../deploy-context";

/** Absolute host source of a bind-mount volume entry, resolved against the slot dir, or null. */
export function bindMountHostSource(vol: string, cwd: string): string | null {
  // A bare absolute path with no colon ("/data") is an anonymous volume.
  const isBind =
    vol.startsWith("./") ||
    vol.startsWith("../") ||
    (vol.startsWith("/") && vol.includes(":"));
  if (!isBind) return null;
  const rawSource = vol.split(":")[0];
  return resolve(cwd, rawSource);
}

/** Numeric uid from a user spec ("1000:1000"), or null when it's a name. */
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

/** Non-root uid a service runs as, or null for root or unknown. */
async function resolveServiceUid(svc: ComposeService): Promise<string | null> {
  // Compose `user:` overrides the image's USER.
  const composeUser = svc.user?.trim();
  if (composeUser) {
    const num = numericUid(composeUser);
    if (num !== null) return num === "0" ? null : num;
    return svc.image ? resolveUidInImage(svc.image, composeUser) : null;
  }

  if (!svc.image) return null; // build-only service, no user: → assume root
  const imageUser = await inspectImageUser(svc.image);
  const num = numericUid(imageUser);
  if (num !== null) return num === "0" ? null : num;
  return imageUser ? resolveUidInImage(svc.image, imageUser) : null;
}

/**
 * Chown a bind-mount target to `uid` via a one-shot container. Best-effort.
 * Only empty directories are touched, so existing user data is never chowned.
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
        // uid is numeric; hostPath stays out of the shell string.
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

/** Chown each service's bind-mount targets to its non-root uid. No-op when bind mounts are disabled. */
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
    if (!uid) continue;

    for (const hostPath of binds) {
      if (chowned.has(hostPath)) continue;
      chowned.add(hostPath);
      await chownIfEmpty(hostPath, uid, name, log);
    }
  }
}
