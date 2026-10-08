// What the restore page shows, and who may see it.

import { needsSetup } from "@/lib/setup";
import { isAppAdmin } from "@/lib/auth/admin";
import { readMarker, tokenMatches } from "./marker";
import { currentRestore, restoreView, type RestoreView } from "./queue";
import { configuredRestoreTarget, describeTarget } from "./source";

export const RESTORE_COOKIE = "vardo_restore";

export type RestoreStatus =
  /** Fresh install: the operator can start one. */
  | { phase: "choose"; configuredTarget: string | null }
  /** The database phase. Detail only for the browser that started it. */
  | { phase: "database"; systemBackupKey?: string; startedAt?: string }
  | { phase: "database-failed"; error?: string; log?: string; configuredTarget: string | null }
  /** The app queue. Needs an admin from the restored database. */
  | { phase: "apps"; signIn: true }
  | { phase: "apps"; signIn: false; restore: NonNullable<RestoreView> }
  /** Set up, no restore on record. */
  | { phase: "none" };

export async function restoreStatus(token: string | undefined): Promise<RestoreStatus> {
  const marker = await readMarker();
  const fresh = await needsSetup();

  if (marker?.phase === "database") {
    return tokenMatches(marker, token)
      ? { phase: "database", systemBackupKey: marker.systemBackupKey, startedAt: marker.startedAt }
      : { phase: "database" };
  }

  if (fresh) {
    const target = await configuredRestoreTarget();
    const configuredTarget = target ? describeTarget(target) : null;
    if (marker?.phase === "failed" && tokenMatches(marker, token)) {
      return { phase: "database-failed", error: marker.error, log: marker.log, configuredTarget };
    }
    return { phase: "choose", configuredTarget };
  }

  const run = await currentRestore().catch(() => null);
  if (!run) return { phase: "none" };
  if (!(await isAppAdmin())) return { phase: "apps", signIn: true };
  const restore = await restoreView(run.id);
  return restore ? { phase: "apps", signIn: false, restore } : { phase: "none" };
}
