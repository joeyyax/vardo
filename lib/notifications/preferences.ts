// Each org's notification switches and nightly backup time. No row means the defaults.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { backupJobs, notificationSettings, organizations } from "@/lib/db/schema";
import { nightlyCron } from "@/lib/backups/run-rules";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_KEYS, type NotificationCategory } from "./registry";

export const DEFAULT_NIGHTLY_TIME = "02:00";

export type OrgNotificationSettings = {
  categories: Record<NotificationCategory, boolean>;
  /** HH:MM UTC. */
  nightlyBackupTime: string;
};

/** Stored switches over the defaults. Unknown keys are dropped. */
export function resolveCategories(stored: Record<string, boolean> | null | undefined): Record<NotificationCategory, boolean> {
  return Object.fromEntries(
    NOTIFICATION_CATEGORY_KEYS.map((key) => [key, stored?.[key] ?? NOTIFICATION_CATEGORIES[key].default]),
  ) as Record<NotificationCategory, boolean>;
}

export async function readOrgNotificationSettings(organizationId: string): Promise<OrgNotificationSettings> {
  const [row, org] = await Promise.all([
    db.query.notificationSettings.findFirst({
      where: eq(notificationSettings.organizationId, organizationId),
      columns: { categories: true },
    }),
    db.query.organizations.findFirst({ where: eq(organizations.id, organizationId), columns: { nightlyBackupTime: true } }),
  ]);
  return { categories: resolveCategories(row?.categories), nightlyBackupTime: org?.nightlyBackupTime ?? DEFAULT_NIGHTLY_TIME };
}

/** Merges a patch. A category back at its default drops out of the stored map. A new time moves every nightly job. */
export async function updateOrgNotificationSettings(
  organizationId: string,
  patch: { categories?: Partial<Record<NotificationCategory, boolean>>; nightlyBackupTime?: string },
): Promise<OrgNotificationSettings> {
  const current = await readOrgNotificationSettings(organizationId);
  const now = new Date();

  if (patch.categories) {
    const merged = { ...current.categories, ...patch.categories };
    const stored = Object.fromEntries(
      NOTIFICATION_CATEGORY_KEYS.filter((key) => merged[key] !== NOTIFICATION_CATEGORIES[key].default).map((key) => [key, merged[key]]),
    );
    await db
      .insert(notificationSettings)
      .values({ organizationId, categories: stored, updatedAt: now })
      .onConflictDoUpdate({ target: notificationSettings.organizationId, set: { categories: stored, updatedAt: now } });
    current.categories = resolveCategories(stored);
  }

  if (patch.nightlyBackupTime && patch.nightlyBackupTime !== current.nightlyBackupTime) {
    await db.update(organizations).set({ nightlyBackupTime: patch.nightlyBackupTime }).where(eq(organizations.id, organizationId));
    await db
      .update(backupJobs)
      .set({ schedule: nightlyCron(patch.nightlyBackupTime), updatedAt: now })
      .where(and(eq(backupJobs.organizationId, organizationId), eq(backupJobs.nightly, true)));
    current.nightlyBackupTime = patch.nightlyBackupTime;
  }
  return current;
}
