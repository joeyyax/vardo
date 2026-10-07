import { isSharedService } from "./slot-partition";
import type { ComposeFile, ComposeService } from "./compose-types";

/** Strip the container path and mode, leaving the volume name. */
function volumeSource(mount: string): string {
  return mount.split(":")[0];
}

/** Named volumes mounted only by shared services; these stay compose-native so the shared project keeps its names. */
export function sharedOnlyVolumes(compose: ComposeFile): Set<string> {
  return volumesByOwner(compose).sharedOnly;
}

/** External name for a volume both a shared and a rotating service mount. Must match the shared project's name or it gets an empty volume. */
export function crossBoundaryVolumeName(
  compose: ComposeFile,
  volName: string,
  fallbackPrefix: string,
): string {
  const prefix = compose.name ?? fallbackPrefix;
  return `${prefix}_${volName}`;
}

/**
 * Volumes mounted by a shared service, split by whether a rotating service also mounts them.
 * Reads the marker only, not detection: a detected service's data already sits under the externalized name.
 */
export function volumesByOwner(compose: ComposeFile): {
  sharedOnly: Set<string>;
  crossBoundary: Set<string>;
} {
  const empty = { sharedOnly: new Set<string>(), crossBoundary: new Set<string>() };
  const declared = new Set(Object.keys(compose.volumes ?? {}));
  if (declared.size === 0) return empty;

  const shared: ComposeService[] = [];
  const slotted: ComposeService[] = [];
  for (const service of Object.values(compose.services ?? {})) {
    (isSharedService(service) ? shared : slotted).push(service);
  }
  if (shared.length === 0) return empty;

  const usedBySlotted = new Set<string>();
  for (const service of slotted) {
    for (const mount of service.volumes ?? []) usedBySlotted.add(volumeSource(mount));
  }

  const sharedOnly = new Set<string>();
  const crossBoundary = new Set<string>();
  for (const service of shared) {
    for (const mount of service.volumes ?? []) {
      const name = volumeSource(mount);
      if (!declared.has(name)) continue;
      (usedBySlotted.has(name) ? crossBoundary : sharedOnly).add(name);
    }
  }
  return { sharedOnly, crossBoundary };
}
