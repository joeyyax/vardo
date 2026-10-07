// Detects services a blue/green rotation would corrupt.
// Externalized volumes and absolute bind sources are shared by both slots; two engines on one data directory lose it.

import { ownsDataDirectory } from "./image-updates/stateful-image";
import type { ComposeFile } from "./compose-types";

/** Docker's 64-hex anonymous volume name. Local copy avoids an import cycle via compose-validate. */
const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;

/** Container paths a data engine writes its on-disk format to, so config and initdb bind mounts don't count. */
const DATA_DIRECTORIES = [
  "/var/lib/postgresql",
  "/var/lib/mysql",
  "/var/lib/influxdb",
  "/var/lib/influxdb2",
  "/usr/share/elasticsearch/data",
  "/usr/share/opensearch/data",
  "/meili_data",
  "/qdrant/storage",
  "/var/lib/clickhouse",
  "/opt/couchdb/data",
  "/var/lib/cassandra",
  "/var/solr",
  "/etcd-data",
  "/var/lib/etcd",
  "/data",
];

/**
 * Non-built data-engine services mounting a declared volume or an absolute bind on their data directory.
 * Kept narrow: a shared service stops being updated.
 */
export function volumeSharedServices(compose: ComposeFile): Set<string> {
  const found = new Set<string>();
  const declared = declaredVolumes(compose);

  for (const [name, service] of Object.entries(compose.services ?? {})) {
    if (service.build || !service.image) continue;
    if (!ownsDataDirectory(service.image)) continue;
    if (slotIndependentMounts(service.volumes, declared).length > 0) found.add(name);
  }
  return found;
}

/** Top-level volume names externalization would rewrite. */
export function declaredVolumes(compose: ComposeFile): Set<string> {
  return new Set(
    Object.keys(compose.volumes ?? {}).filter((name) => !ANONYMOUS_VOLUME.test(name)),
  );
}

/** Volume and bind mounts that reach past the slot, as written. */
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

/** Absolute host paths a service bind-mounts onto a data directory. Relative sources resolve per slot. */
export function sharedBindMounts(mounts: string[] | undefined): string[] {
  return (mounts ?? []).filter((mount) => {
    const [source, target] = mount.split(":");
    if (!source?.startsWith("/") || !target?.startsWith("/")) return false;
    return DATA_DIRECTORIES.some((dir) => target === dir || target.startsWith(`${dir}/`));
  });
}
