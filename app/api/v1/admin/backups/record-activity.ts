import { recordActivity } from "@/lib/activity";
import { findVardoOrgId } from "@/lib/infra/vardo-org";

/** Instance-level backups have no org; their activity goes to the Vardo system org. */
export async function recordAdminBackupActivity(
  action: string,
  backup: { id: string; organizationId: string | null; appId: string | null; volumeName: string | null },
  userId: string,
) {
  const organizationId = backup.organizationId ?? (await findVardoOrgId());
  if (!organizationId) return;
  await recordActivity({
    organizationId,
    action,
    appId: backup.appId ?? undefined,
    userId,
    metadata: { backupId: backup.id, volumeName: backup.volumeName, source: "admin" },
  });
}
