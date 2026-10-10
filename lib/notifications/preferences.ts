// Each org's notification switches and backup batch window. No row means the defaults.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notificationSettings } from "@/lib/db/schema";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_KEYS, type NotificationCategory } from "./registry";

export const DEFAULT_BATCH_WINDOW_MINUTES = 30;
export const MIN_BATCH_WINDOW_MINUTES = 5;
export const MAX_BATCH_WINDOW_MINUTES = 240;

export type OrgNotificationSettings = {
  categories: Record<NotificationCategory, boolean>;
  batchWindowMinutes: number;
};

/** Stored switches over the defaults. Unknown keys are dropped. */
export function resolveSettings(row: { categories: Record<string, boolean>; batchWindowMinutes: number } | null | undefined): OrgNotificationSettings {
  const categories = Object.fromEntries(
    NOTIFICATION_CATEGORY_KEYS.map((key) => [key, row?.categories[key] ?? NOTIFICATION_CATEGORIES[key].default]),
  ) as Record<NotificationCategory, boolean>;
  return { categories, batchWindowMinutes: row?.batchWindowMinutes ?? DEFAULT_BATCH_WINDOW_MINUTES };
}

export async function readOrgNotificationSettings(organizationId: string): Promise<OrgNotificationSettings> {
  const row = await db.query.notificationSettings.findFirst({
    where: eq(notificationSettings.organizationId, organizationId),
    columns: { categories: true, batchWindowMinutes: true },
  });
  return resolveSettings(row);
}

/** Merges a patch. A category back at its default drops out of the stored map. */
export async function updateOrgNotificationSettings(
  organizationId: string,
  patch: { categories?: Partial<Record<NotificationCategory, boolean>>; batchWindowMinutes?: number },
): Promise<OrgNotificationSettings> {
  const current = await readOrgNotificationSettings(organizationId);
  const merged = { ...current.categories, ...patch.categories };
  const stored = Object.fromEntries(
    NOTIFICATION_CATEGORY_KEYS.filter((key) => merged[key] !== NOTIFICATION_CATEGORIES[key].default).map((key) => [key, merged[key]]),
  );
  const batchWindowMinutes = patch.batchWindowMinutes ?? current.batchWindowMinutes;
  const now = new Date();
  await db
    .insert(notificationSettings)
    .values({ organizationId, categories: stored, batchWindowMinutes, updatedAt: now })
    .onConflictDoUpdate({ target: notificationSettings.organizationId, set: { categories: stored, batchWindowMinutes, updatedAt: now } });
  return resolveSettings({ categories: stored, batchWindowMinutes });
}
