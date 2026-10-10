// Behavior-first stateful detection. Names are the fallback, so a renamed postgres image still counts.

import { isMajorLocked, ownsDataDirectory } from "./stateful-image";

/** Files an engine writes into its data directory. Finding one marks the directory major-locked. */
export const DATA_STAMPS: { file: string; engine: string }[] = [
  { file: "PG_VERSION", engine: "PostgreSQL" },
  { file: "mysql_upgrade_info", engine: "MySQL or MariaDB" },
  { file: "mysql.ibd", engine: "MySQL" },
  { file: "aria_log_control", engine: "MariaDB" },
  { file: "storage.bson", engine: "MongoDB" },
];

/** OCI label naming the image this one was built from. */
export const BASE_IMAGE_LABEL = "org.opencontainers.image.base.name";

export type StatefulSource = "behavior" | "base-image" | "name" | "none";

export interface StatefulVerdict {
  /** Two copies on one directory would corrupt it. */
  ownsData: boolean;
  /** A major bump means migrating the data directory. */
  majorLocked: boolean;
  source: StatefulSource;
  /** Image VOLUME that a persistent mount covers, e.g. `/var/lib/postgresql/data`. */
  dataPath: string | null;
  /** Stamp file found there, e.g. `PG_VERSION`. */
  stamp: string | null;
  /** Plain reason for the default, e.g. "stores data in /var/lib/postgresql/data". */
  reason: string | null;
}

export interface DetectInput {
  image: string;
  /** Paths the image config declares as VOLUME. */
  imageVolumes: string[];
  /** Destinations of the container's persistent mounts (named volumes and binds). */
  mounts: string[];
  /** Stamp files present in `dataPath`. */
  stamps?: string[];
  labels?: Record<string, string>;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The first image VOLUME with a persistent mount at or above it. */
export function coveredDataPath(imageVolumes: string[], mounts: string[]): string | null {
  const roots = mounts.map(trimSlash);
  for (const raw of imageVolumes) {
    const volume = trimSlash(raw);
    if (roots.some((m) => volume === m || volume.startsWith(m === "/" ? "/" : `${m}/`))) return volume;
  }
  return null;
}

/** Behavior first: a mounted image VOLUME, then a stamp in it. Base-image label, then the name lists. */
export function detectStateful(input: DetectInput): StatefulVerdict {
  const dataPath = coveredDataPath(input.imageVolumes, input.mounts);
  const stamp = dataPath ? (DATA_STAMPS.find((s) => input.stamps?.includes(s.file))?.file ?? null) : null;
  const base = input.labels?.[BASE_IMAGE_LABEL] ?? null;

  if (dataPath) {
    return {
      ownsData: true,
      majorLocked: stamp !== null || isMajorLocked(input.image) || (base !== null && isMajorLocked(base)),
      source: "behavior",
      dataPath,
      stamp,
      reason: `stores data in ${dataPath}`,
    };
  }

  if (base && ownsDataDirectory(base)) {
    return {
      ownsData: true,
      majorLocked: isMajorLocked(base),
      source: "base-image",
      dataPath: null,
      stamp: null,
      reason: `built on ${base}`,
    };
  }

  if (ownsDataDirectory(input.image)) {
    return {
      ownsData: true,
      majorLocked: isMajorLocked(input.image),
      source: "name",
      dataPath: null,
      stamp: null,
      reason: "a known database image",
    };
  }

  return { ownsData: false, majorLocked: false, source: "none", dataPath: null, stamp: null, reason: null };
}

/** Verdict from the name lists alone, for services not probed yet. */
export function verdictByName(image: string): StatefulVerdict {
  return detectStateful({ image, imageVolumes: [], mounts: [] });
}
