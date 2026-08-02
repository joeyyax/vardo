import { partitionBySlot } from "./slot-partition";
import type { ComposeFile } from "./compose-types";

/** Strip the container path and mode, leaving the volume name. */
function volumeSource(mount: string): string {
  return mount.split(":")[0];
}

/**
 * Named volumes mounted only by services that never rotate.
 *
 * Externalizing a volume exists so it survives a slot swap. A shared service is
 * not swapped, so its volumes can stay compose-native — which is what lets a
 * pinned shared project keep the volume names it already created.
 *
 * A volume touched by any rotating service is excluded: that one still has to
 * outlive the slot.
 */
export function sharedOnlyVolumes(compose: ComposeFile): Set<string> {
  return volumesByOwner(compose).sharedOnly;
}

/**
 * External name for a volume both a shared and a rotating service mount.
 *
 * It has to be external — one volume referenced from two compose projects has
 * no other form — but the name must be what the shared project already calls
 * it, or the shared service is handed an empty volume on the first deploy.
 */
export function crossBoundaryVolumeName(
  compose: ComposeFile,
  volName: string,
  fallbackPrefix: string,
): string {
  const prefix = compose.name ?? fallbackPrefix;
  return `${prefix}_${volName}`;
}

/** Volumes mounted by a shared service, split by whether anything rotating also mounts them. */
export function volumesByOwner(compose: ComposeFile): {
  sharedOnly: Set<string>;
  crossBoundary: Set<string>;
} {
  const empty = { sharedOnly: new Set<string>(), crossBoundary: new Set<string>() };
  const declared = new Set(Object.keys(compose.volumes ?? {}));
  if (declared.size === 0) return empty;

  const { shared, slotted } = partitionBySlot(compose);
  if (Object.keys(shared).length === 0) return empty;

  const usedBySlotted = new Set<string>();
  for (const service of Object.values(slotted)) {
    for (const mount of service.volumes ?? []) usedBySlotted.add(volumeSource(mount));
  }

  const sharedOnly = new Set<string>();
  const crossBoundary = new Set<string>();
  for (const service of Object.values(shared)) {
    for (const mount of service.volumes ?? []) {
      const name = volumeSource(mount);
      if (!declared.has(name)) continue;
      (usedBySlotted.has(name) ? crossBoundary : sharedOnly).add(name);
    }
  }
  return { sharedOnly, crossBoundary };
}
