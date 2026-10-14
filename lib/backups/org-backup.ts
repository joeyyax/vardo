import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, backups } from "@/lib/db/schema";

/** Backups the org owns: a live app's follow the app, the rest follow the row. */
// App columns are named as text: a relational query re-aliases column objects.
export function orgBackupScope(orgId: string) {
  return or(
    sql`${backups.appId} in (select "id" from "app" where "organization_id" = ${orgId})`,
    and(
      eq(backups.organizationId, orgId),
      or(isNull(backups.appId), sql`${backups.appId} not in (select "id" from "app")`),
    ),
  )!;
}

/** The org's backups of apps that no longer exist. */
export function deletedAppBackupScope(orgId: string) {
  return and(
    orgBackupScope(orgId),
    isNotNull(backups.appId),
    sql`${backups.appId} not in (select "id" from "app")`,
  )!;
}

/** The org a loaded backup belongs to, by the same rule as orgBackupScope. */
export function backupOwnerOrgId(backup: {
  organizationId: string | null;
  app: { organizationId: string } | null;
}) {
  return backup.app ? backup.app.organizationId : backup.organizationId;
}

/** An app backup owned by the org, including one whose app was deleted. */
export async function findOrgAppBackup(orgId: string, backupId: string) {
  const backup = await db.query.backups.findFirst({
    where: and(eq(backups.id, backupId), isNotNull(backups.appId), orgBackupScope(orgId)),
    with: { app: { columns: { id: true, name: true, organizationId: true } } },
  });
  if (!backup || backupOwnerOrgId(backup) !== orgId) return null;
  return backup;
}

export type DrillableBackup =
  | { ok: true; backup: NonNullable<Awaited<ReturnType<typeof findOrgAppBackup>>> }
  | { ok: false; reason: "not_found" | "not_successful" };

/** An org's app backup that a restore drill can run on: owned by the org and successful. */
export async function findDrillableBackup(orgId: string, backupId: string): Promise<DrillableBackup> {
  const backup = await findOrgAppBackup(orgId, backupId);
  if (!backup) return { ok: false, reason: "not_found" };
  if (backup.status !== "success") return { ok: false, reason: "not_successful" };
  return { ok: true, backup };
}

/** Moves each live app's backups to the app's org. Returns the rows moved. */
export async function realignBackupOrgs(): Promise<number> {
  const moved = await db
    .update(backups)
    .set({ organizationId: sql`${apps.organizationId}` })
    .from(apps)
    .where(
      and(
        eq(backups.appId, apps.id),
        sql`${backups.organizationId} IS DISTINCT FROM ${apps.organizationId}`,
      ),
    )
    .returning({ id: backups.id });
  return moved.length;
}
