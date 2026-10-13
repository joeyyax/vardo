// The alert a failed backup, restore, import or drill fires, and its cause in plain words. No I/O.

import type { AlertItem } from "@/lib/bus/events";
import { formatClock, UTC, zoneAbbreviation } from "@/lib/time-zone";
import { failureSubject, type BackupResultItem } from "./run-rules";

const DUMP_TOOL = /^(mysqldump|mariadb-dump|pg_dumpall|pg_dump|mongodump|redis-cli)\b/;

/** The first non-empty line of an error. */
export function firstErrorLine(error: string | undefined): string {
  return error?.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/** The cause in one sentence, only when the error states it outright. Null otherwise. */
export function backupErrorCause(error: string | undefined): string | null {
  if (!error) return null;
  if (/no space left on device|ENOSPC|disk quota exceeded/i.test(error)) return "The disk ran out of space while writing the archive.";
  if (/access denied for user|password authentication failed|authentication failed for user/i.test(error)) {
    return "The database refused the backup's login.";
  }
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|Permission denied \(publickey|403 Forbidden/i.test(error)) {
    return "The backup target rejected its credentials.";
  }
  if (/lost connection to (mysql )?server|server has gone away|server closed the connection unexpectedly|connection reset by peer|ECONNRESET/i.test(error)) {
    const tool = DUMP_TOOL.exec(error.trim())?.[1];
    return tool ? `${tool} lost its connection to the server mid-dump.` : "The connection to the database dropped mid-dump.";
  }
  if (/timed out|ETIMEDOUT|deadline exceeded/i.test(error)) return "It timed out before it finished.";
  if (/no such volume|volume not found/i.test(error)) return "The volume no longer exists.";
  if (/no such container/i.test(error)) return "The app's container isn't there.";
  return null;
}

/** "Oct 8 at 02:04 PDT". */
export function dayAt(iso: string, tz: string = UTC): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
  return `${day} at ${formatClock(date, tz)} ${zoneAbbreviation(date, tz)}`;
}

/** "Shop / mysql-data", or the volume alone when it's named for the app. */
function where(item: Pick<BackupResultItem, "appName" | "volumeName">): string {
  return item.appName && item.appName !== item.volumeName ? `${item.appName} / ${item.volumeName}` : item.volumeName;
}

/**
 * The alert for one failed result. `lastGoodAt` is the volume's last successful backup: null
 * when it has none, undefined when unknown.
 */
export function backupFailureItem(
  item: BackupResultItem,
  opts: { lastGoodAt?: string | null; timeZone?: string } = {},
): AlertItem {
  const name = where(item);
  const title = {
    backup: `Backup of ${name} failed`,
    drill: `Restore drill failed for ${name}`,
    restore: `Restore of ${name} failed`,
    import: `Import into ${name} failed`,
  }[item.kind];
  const [first, then] = {
    backup: ["The last good backup is still there.", "Fix the cause, then run the job again."],
    drill: ["The archive may not restore.", "Run a fresh backup and check it before you need it."],
    restore: ["Nothing was changed past the point it failed.", "Check the log, then try again."],
    import: ["Nothing was changed past the point it failed.", "Check the log, then try again."],
  }[item.kind];
  const line = firstErrorLine(item.error);
  const cause = backupErrorCause(item.error);
  const job = item.jobName ? (item.jobName.startsWith("Auto:") ? "Automatic" : item.jobName) : undefined;

  const lead = item.kind !== "backup" ? [first] : opts.lastGoodAt === null ? ["There's no earlier backup of this volume."] : [];
  return {
    type: "backup.failure",
    about: failureSubject(item),
    severity: "critical",
    title,
    detail: `${item.error ?? "It failed without an error message."} ${first} ${then}`,
    appId: item.appId ?? undefined,
    appName: item.appName ?? undefined,
    facts: [
      ...(item.jobName ? [{ label: "Job", value: item.jobName }] : []),
      { label: "Volume", value: item.volumeName },
    ],
    since: item.at,
    view: {
      ...(item.kind === "backup" && opts.lastGoodAt
        ? { reassure: { strong: "Your data is safe.", text: `The last good backup, from ${dayAt(opts.lastGoodAt, opts.timeZone)}, is still there.` } }
        : {}),
      lead,
      callout: cause
        ? { title: cause.replace(/\.$/, ""), body: line && line !== cause ? line : undefined }
        : { title: line || "It failed without an error message." },
      brief: { title, body: cause ?? (line || "It failed without an error message.") },
      facts: [
        ...(item.appName && item.appName !== item.volumeName ? [{ label: "App", value: item.appName }] : []),
        ...(job ? [{ label: "Job", value: job }] : []),
      ],
      sinceLabel: "Failed",
      ...(item.appId && item.appName ? { action: { label: `Open ${item.appName}'s backups`, path: `/apps/${item.appId}/backups` } } : {}),
    },
  };
}
