// ---------------------------------------------------------------------------
// Detecting a service a blue/green rotation would corrupt.
//
// A named volume is externalized to `<app>-<env>_<volume>`, which carries no
// slot, so blue and green address one directory. Rotating a database over that
// runs two engines against one data directory — glitchtip-production held
// `postgres-data` from both slots for two seconds and lost the cluster.
//
// An absolute bind source is the same hazard reached a different way: nothing
// externalizes it because nothing has to — the host path is already outside
// every slot. outline, paperless, gitea, authentik and immich all keep their
// Postgres data directory this way.
// ---------------------------------------------------------------------------

import { ownsDataDirectory } from "./image-updates/stateful-image";
import type { ComposeFile } from "./compose-types";

/**
 * Docker's 64-hex name for an anonymous volume. Never externalized, so each
 * slot gets its own copy. Kept local — importing compose-validate here would
 * close a cycle back through slot-partition.
 */
const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;

/**
 * Container paths a data engine writes its on-disk format to.
 *
 * The gate the named-volume arm gets from `volumes:` — a host path is declared
 * nowhere, so the mount itself is all there is to go on. Without it a bind
 * mount for a config file or an initdb script would read as a data directory.
 */
const DATA_DIRECTORIES = [
  "/var/lib/postgresql",
  "/var/lib/mysql",
  "/var/lib/influxdb",
  "/var/lib/influxdb2",
  "/usr/share/elasticsearch/data",
  "/usr/share/opensearch/data",
  "/data",
];

/**
 * Services whose data directory both slots would address at once.
 *
 * The image must be one whose on-disk format it owns, and the service must not
 * build, because a service this deploy compiles is the one it exists to ship.
 * The mount then has to reach a directory no slot component addresses: a volume
 * declared at the top level, which is the only kind externalization touches, or
 * an absolute bind source landing on the engine's data directory. An anonymous
 * volume is recreated per slot and an undeclared source is neither.
 *
 * Narrow on purpose. Treating a service as shared stops it being updated, so a
 * loose signature costs more than the rotation it prevents.
 */
export function volumeSharedServices(compose: ComposeFile): Set<string> {
  const found = new Set<string>();
  const declared = new Set(
    Object.keys(compose.volumes ?? {}).filter((name) => !ANONYMOUS_VOLUME.test(name)),
  );

  for (const [name, service] of Object.entries(compose.services ?? {})) {
    if (service.build || !service.image) continue;
    if (!ownsDataDirectory(service.image)) continue;
    if (slotIndependentMounts(service.volumes, declared).length > 0) found.add(name);
  }
  return found;
}

/** Mounts of either kind that reach past the slot, as written in the compose file. */
export function slotIndependentMounts(
  mounts: string[] | undefined,
  declared: Set<string>,
): string[] {
  return [...sharedVolumeMounts(mounts, declared), ...sharedBindMounts(mounts)];
}

/** Top-level volumes a service mounts, by the name they are declared under. */
export function sharedVolumeMounts(
  mounts: string[] | undefined,
  declared: Set<string>,
): string[] {
  return (mounts ?? []).map((mount) => mount.split(":")[0]).filter((src) => declared.has(src));
}

/**
 * Host paths a service bind-mounts onto a data directory.
 *
 * Absolute sources only. A relative one resolves against the slot dir the
 * deploy runs compose from, so it is either symlinked back to the repo or
 * created fresh per slot — slot-independence that depends on the repo is not
 * something to promote a service on.
 */
export function sharedBindMounts(mounts: string[] | undefined): string[] {
  return (mounts ?? []).filter((mount) => {
    const [source, target] = mount.split(":");
    if (!source?.startsWith("/") || !target?.startsWith("/")) return false;
    return DATA_DIRECTORIES.some((dir) => target === dir || target.startsWith(`${dir}/`));
  });
}
