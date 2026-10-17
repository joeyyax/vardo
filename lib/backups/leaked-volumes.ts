// Finds volumes earlier drills leaked. Read-only: it lists candidates and never removes anything.

import { SCRATCH_LABEL } from "./scratch";

export type DbKind = "postgres" | "mysql" | "mariadb";

export type VolumeFacts = {
  name: string;
  labels: Record<string, string>;
  /** ISO time Docker created it. */
  createdAt: string | null;
  /** Output of `find` over the volume for the marker files in `PROBE_MARKERS`. */
  markers: string;
  sizeKb: number | null;
};

export type LeakCandidate = {
  name: string;
  createdAt: string | null;
  kind: DbKind;
  sizeKb: number | null;
  /** Carries `vardo.scratch=drill`, so Vardo made it. Unlabeled candidates are inferred from content and age. */
  labeled: boolean;
};

export const PROBE_MARKERS = ["PG_VERSION", "ibdata1", "aria_log_control", "mariadb_upgrade_info"];

const ANONYMOUS = /^[0-9a-f]{64}$/;

/** Data directory type from the marker files found in a volume, or null when it isn't a database. */
export function databaseKind(markers: string): DbKind | null {
  if (/(^|\/)PG_VERSION$/m.test(markers)) return "postgres";
  if (/(^|\/)(aria_log_control|mariadb_upgrade_info)$/m.test(markers)) return "mariadb";
  if (/(^|\/)ibdata1$/m.test(markers)) return "mysql";
  return null;
}

/** Pure. `volumes` must be dangling ones; a volume any container mounts is never a candidate. */
export function leakCandidates(volumes: VolumeFacts[], opts: { since: Date }): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const v of volumes) {
    const labeled = v.labels[SCRATCH_LABEL] === "drill";
    const anonymous = ANONYMOUS.test(v.name) || v.labels["com.docker.volume.anonymous"] !== undefined;
    if (!labeled && !anonymous) continue;
    const kind = databaseKind(v.markers);
    if (!kind) continue;
    if (!labeled) {
      const created = v.createdAt ? Date.parse(v.createdAt) : NaN;
      if (!Number.isFinite(created) || created < opts.since.getTime()) continue;
    }
    out.push({ name: v.name, createdAt: v.createdAt, kind, sizeKb: v.sizeKb, labeled });
  }
  return out.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.name.localeCompare(b.name));
}
