// Reads the version a datastore's data directory was written by, from inside the running container.

/** Where an engine records the format version of its data directory. */
interface VersionStamp {
  match: RegExp;
  /** Shell run inside the running container. Prints the major, or nothing. */
  probe: string;
}

const STAMPS: VersionStamp[] = [
  {
    match: /^(?:.*\/)?(postgres|postgis|pgvector|timescaledb?)\b/i,
    probe: 'cat "${PGDATA:-/var/lib/postgresql/data}/PG_VERSION" 2>/dev/null',
  },
  {
    match: /^(?:.*\/)?mariadb\b/i,
    probe: 'cat /var/lib/mysql/mysql_upgrade_info 2>/dev/null',
  },
  {
    match: /^(?:.*\/)?mongo\b/i,
    probe:
      'mongod --version 2>/dev/null | head -1 | sed -n "s/.*v\\([0-9]*\\).*/\\1/p"',
  },
];

/** The shell that reads this image's data-directory version, if known. */
export function versionProbeFor(image: string): string | null {
  const repo = image.split("@")[0].replace(/:[^:/]*$/, "");
  return STAMPS.find((s) => s.match.test(repo))?.probe ?? null;
}

/** Leading integer of a version stamp: `16`, `16.2`, `10.11.2-MariaDB` → 16/10. */
export function parseDataVersion(raw: string): number | null {
  const match = raw.trim().match(/^(\d+)/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

export type DataVersionVerdict =
  | { kind: "ok" }
  | { kind: "unknown"; reason: string }
  | { kind: "mismatch"; onDisk: number; image: number; message: string };

/** Compare the data directory's version against the major the new image would run. */
export function checkDataVersion(
  image: string,
  imageTag: string,
  stamp: string | null,
): DataVersionVerdict {
  if (stamp === null || stamp.trim() === "") {
    return { kind: "unknown", reason: "no version stamp on disk" };
  }
  const onDisk = parseDataVersion(stamp);
  if (onDisk === null) return { kind: "unknown", reason: `unreadable stamp: ${stamp.trim()}` };

  const imageMajor = parseDataVersion(imageTag.replace(/^v/, ""));
  if (imageMajor === null) {
    return { kind: "unknown", reason: `tag has no major: ${imageTag}` };
  }
  if (onDisk === imageMajor) return { kind: "ok" };

  const direction = imageMajor > onDisk ? "newer than" : "older than";
  return {
    kind: "mismatch",
    onDisk,
    image: imageMajor,
    message:
      `${image} would run major ${imageMajor}, ${direction} the data directory written by ` +
      `major ${onDisk}. The container will refuse to start. Migrate the data first.`,
  };
}
