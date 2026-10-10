import { isFeatureEnabledAsync } from "@/lib/config/features";
import { authorize, type Actor } from "./actor";
import { listAppOptions } from "./apps";

/** Apps a backup job can include. */
export async function listBackupAppOptions(actor: Actor) {
  authorize(actor, "backup.view");
  return listAppOptions(actor);
}

/** The backups page: off when the feature is, else the apps its jobs can include. */
export async function loadBackupsPage(actor: Actor) {
  if (!(await isFeatureEnabledAsync("backups"))) return { enabled: false as const, apps: [] };
  return { enabled: true as const, apps: await listBackupAppOptions(actor) };
}
