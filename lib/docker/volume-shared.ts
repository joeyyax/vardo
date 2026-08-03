// ---------------------------------------------------------------------------
// Detecting a service a blue/green rotation would corrupt.
//
// A named volume is externalized to `<app>-<env>_<volume>`, which carries no
// slot, so blue and green address one directory. Rotating a database over that
// runs two engines against one data directory — glitchtip-production held
// `postgres-data` from both slots for two seconds and lost the cluster.
// ---------------------------------------------------------------------------

import { isMajorLocked } from "./image-updates/stateful-image";
import type { ComposeFile } from "./compose-types";

/**
 * Docker's 64-hex name for an anonymous volume. Never externalized, so each
 * slot gets its own copy. Kept local — importing compose-validate here would
 * close a cycle back through slot-partition.
 */
const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;

/**
 * Services whose data directory both slots would address at once.
 *
 * Three conditions, all required. The image must be one whose on-disk format it
 * owns — the same list a major bump is gated on. The mount must resolve to a
 * volume declared at the top level, which is the only kind externalization
 * touches: a bind mount keeps its host path, an anonymous volume is recreated
 * per slot, and an undeclared source is neither. And the service must not
 * build, because a service this deploy compiles is the one it exists to ship.
 *
 * Narrow on purpose. Treating a service as shared stops it being updated, so a
 * loose signature costs more than the rotation it prevents.
 */
export function volumeSharedServices(compose: ComposeFile): Set<string> {
  const found = new Set<string>();
  const declared = new Set(
    Object.keys(compose.volumes ?? {}).filter((name) => !ANONYMOUS_VOLUME.test(name)),
  );
  if (declared.size === 0) return found;

  for (const [name, service] of Object.entries(compose.services ?? {})) {
    if (service.build || !service.image) continue;
    if (!isMajorLocked(service.image)) continue;
    if (sharedVolumeMounts(service.volumes, declared).length > 0) found.add(name);
  }
  return found;
}

/** Top-level volumes a service mounts, by the name they are declared under. */
export function sharedVolumeMounts(
  mounts: string[] | undefined,
  declared: Set<string>,
): string[] {
  return (mounts ?? []).map((mount) => mount.split(":")[0]).filter((src) => declared.has(src));
}
