import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userPreferences, type UiDensity } from "@/lib/db/schema";

export type UserPreferences = { density: UiDensity };

export const DEFAULT_PREFERENCES: UserPreferences = { density: "comfortable" };

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const row = await db.query.userPreferences.findFirst({
    where: eq(userPreferences.userId, userId),
    columns: { density: true },
  });
  return row ? { density: row.density } : DEFAULT_PREFERENCES;
}

export async function setUserPreferences(userId: string, prefs: Partial<UserPreferences>): Promise<void> {
  const now = new Date();
  await db
    .insert(userPreferences)
    .values({ userId, ...DEFAULT_PREFERENCES, ...prefs, updatedAt: now })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...prefs, updatedAt: now } });
}
