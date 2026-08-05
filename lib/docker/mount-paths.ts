// ---------------------------------------------------------------------------
// Host paths a bind mount may point at.
//
// One list, two very different consumers. Compose validation uses it to refuse
// a container that would mount something dangerous — the blast radius there is
// one container. The backup engine uses it to decide what may be archived and,
// far more consequentially, what may be **restored over**: restore deletes the
// destination's contents before writing. A path that only reaches the wrong
// container is a bug; a path that reaches the wrong restore destination is
// somebody's host.
//
// Compose is also not the only way a bind source is recorded. The adopt and
// import routes write `volume.source` straight from `docker inspect`, so a row
// pointing at /etc exists whether or not compose would ever have allowed it.
// Anything consuming that column has to check it itself.
// ---------------------------------------------------------------------------

import { resolve } from "path";

/**
 * Paths a container may not bind-mount. Prefix-matched.
 *
 * Kept narrow on purpose. Mounting a host binary read-only is an ordinary
 * pattern — code-server mounts `/usr/bin/docker` — and widening this list
 * breaks working apps at their next deploy.
 */
export const DENIED_MOUNT_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/var/run/docker.sock",
  "/root",
];

/**
 * Paths the backup engine may not archive or restore over.
 *
 * Stricter than the compose list, because the consequences are not comparable.
 * Mounting `/usr/bin/docker` into a container is fine; *restoring over* `/usr`
 * is the end of the host. Restore deletes the destination's contents first, so
 * this list is what stands between a mistyped source and an unbootable machine.
 *
 * `/var/lib` and `/home` are deliberately absent — application data lives in
 * both — while `/var/lib/docker` is present, because restoring over it takes
 * every volume on the host, including the staging area holding the archive.
 * `/root` comes from the compose list and covers the one home worth refusing.
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

/**
 * Both readings of a path: relative to the process, and relative to the root.
 *
 * A traversal such as `../../../var/run/docker.sock` resolves differently
 * depending on the working directory, so a check against one form alone is
 * bypassable (#744). Both are compared.
 */
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
 * Vet a host path before it is handed to `docker run -v`.
 *
 * Rejects, in order: a value Docker would read as a **volume name** rather than
 * a path (no leading slash — `data` is a named volume, not `./data`); a colon,
 * which would restructure the `-v` argument into a different destination or
 * mode; a traversal surviving normalization; and anything on the deny-list.
 *
 * Lexical only, and deliberately so. Vardo runs in a container while `-v` is
 * interpreted against the *host* filesystem, so `fs.stat` here would inspect
 * the wrong machine and return confident nonsense. Existence and type are
 * checked inside the one-shot container instead.
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
