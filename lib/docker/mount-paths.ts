// Host paths a bind mount or backup restore may point at.
// Adopt and import write volume.source straight from docker inspect, so consumers must check it themselves.

import { resolve } from "path";

/** Paths a container may not bind-mount. Prefix-matched; widening it breaks working apps on their next deploy. */
export const DENIED_MOUNT_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/var/run/docker.sock",
  "/root",
];

/**
 * Paths the backup engine may not archive or restore over (restore wipes the destination first).
 * `/var/lib` and `/home` hold app data and stay allowed; `/var/lib/docker` never.
 */
export const DENIED_BACKUP_PATHS = [
  ...DENIED_MOUNT_PATHS,
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/lib",
  "/sbin",
  "/usr",
  "/var/lib/docker",
];

/** A path resolved against the cwd and against root; checking one alone is bypassable (#744). */
export function resolveBothWays(rawSource: string): [string, string] {
  return [resolve(rawSource), resolve("/", rawSource)];
}

/** The deny-list entry a path falls under, or null. Prefix match. */
export function deniedMountReason(
  rawSource: string,
  denyList: string[] = DENIED_BACKUP_PATHS,
  extraDenied: string[] = [],
): string | null {
  const denied = [...denyList, ...extraDenied.filter(Boolean)];
  for (const candidate of resolveBothWays(rawSource)) {
    for (const p of denied) {
      // "/" would prefix-match everything, so it only ever matches exactly.
      if (candidate === p) return p;
      if (p !== "/" && candidate.startsWith(p + "/")) return p;
    }
  }
  return null;
}

export class UnsafeMountPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeMountPathError";
  }
}

/**
 * Vet a host path for `docker run -v`: absolute, no colon, no `..`, not deny-listed.
 * Lexical only; `fs.stat` here would read Vardo's container, not the host.
 */
export function assertSafeBindSource(
  rawSource: string,
  opts?: { dockerRoot?: string | null; label?: string },
): string {
  const label = opts?.label ?? "bind source";

  if (!rawSource || !rawSource.trim()) {
    throw new UnsafeMountPathError(`${label} is empty`);
  }
  const source = rawSource.trim();

  if (!source.startsWith("/")) {
    throw new UnsafeMountPathError(
      `${label} "${source}" is not an absolute path — Docker would read it as a volume name`,
    );
  }
  if (source.includes(":")) {
    throw new UnsafeMountPathError(
      `${label} "${source}" contains a colon, which would change what the mount means`,
    );
  }
  if (source.split("/").includes("..")) {
    throw new UnsafeMountPathError(`${label} "${source}" contains a parent-directory segment`);
  }

  const denied = deniedMountReason(
    source,
    DENIED_BACKUP_PATHS,
    opts?.dockerRoot ? [opts.dockerRoot] : [],
  );
  if (denied) {
    throw new UnsafeMountPathError(
      `${label} "${source}" is under ${denied}, which must never be archived or restored over`,
    );
  }

  return resolve(source);
}
