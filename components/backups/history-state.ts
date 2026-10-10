import type { RecentBackup } from "./types";

export type RestoreTest =
  | { kind: "none" }
  | { kind: "untested" }
  | { kind: "verified"; at: string; detail: string | null }
  | { kind: "failed"; at: string | null; detail: string | null }
  | { kind: "unsupported"; detail: string | null };

/** Whether the archive was written encrypted and is still stored. */
export function isEncryptedRun(run: { storagePath: string | null; archiveKeyFingerprint?: string | null }): boolean {
  return !!run.storagePath && !!run.archiveKeyFingerprint;
}

/** Whether a restore drill has proven this backup restorable. */
export function restoreTestFor(
  backup: Pick<RecentBackup, "status" | "storagePath" | "verifiedAt" | "verifyOutcome" | "verifyDetail">,
): RestoreTest {
  if (backup.status !== "success" || !backup.storagePath) return { kind: "none" };
  switch (backup.verifyOutcome) {
    case "verified":
      return backup.verifiedAt
        ? { kind: "verified", at: backup.verifiedAt, detail: backup.verifyDetail }
        : { kind: "untested" };
    case "failed":
      return { kind: "failed", at: backup.verifiedAt, detail: backup.verifyDetail };
    case "unsupported":
      return { kind: "unsupported", detail: backup.verifyDetail };
    default:
      return { kind: "untested" };
  }
}

/** The reason a backup failed or was skipped, from its run log. Null when there's no log. */
export function failureReason(log: string | null): string | null {
  const lines = (log ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const stamp = /^\[\d{4}-\d\d-\d\dT[^\]]*\]\s*/;
  const failed = [...lines].reverse().find((l) => stamp.test(l) && /Backup failed:|Skipping volume/.test(l));
  return (failed ?? lines[lines.length - 1]).replace(stamp, "").replace(/^Backup failed:\s*/, "");
}
