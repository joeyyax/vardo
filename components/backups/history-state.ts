import type { RecentBackup } from "./types";

export type RestoreTest =
  | { kind: "none" }
  | { kind: "untested" }
  | { kind: "verified"; at: string; detail: string | null }
  | { kind: "failed"; at: string | null; detail: string | null }
  | { kind: "unsupported"; detail: string | null };

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
