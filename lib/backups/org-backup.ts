import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";

/**
 * An app backup owned by the org, including one whose app was deleted
 * (`app` is then null). System backups have no app and never match.
 */
export async function findOrgAppBackup(orgId: string, backupId: string) {
  const backup = await db.query.backups.findFirst({
    where: and(
      eq(backups.id, backupId),
      eq(backups.organizationId, orgId),
      isNotNull(backups.appId),
    ),
    with: { app: { columns: { id: true, name: true, organizationId: true } } },
  });
  if (!backup || (backup.app && backup.app.organizationId !== orgId)) return null;
  return backup;
}
