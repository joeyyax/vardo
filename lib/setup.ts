import { db } from "@/lib/db";
import { systemSettings, user } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { setSystemSetting } from "@/lib/system-settings";

/** Presence of this row is the record that first-run setup already happened. */
const SETUP_COMPLETED_KEY = "setup_completed";

/** Writes the latch. Idempotent. */
async function markSetupCompleted(): Promise<void> {
  await setSystemSetting(SETUP_COMPLETED_KEY, new Date().toISOString());
}

async function setupLatched(): Promise<boolean> {
  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, SETUP_COMPLETED_KEY),
    columns: { key: true },
  });
  return row !== undefined;
}

/**
 * Whether first-run setup is still open. Latches shut the first time an account
 * is seen and never reopens, so an empty user table cannot hand out a new admin.
 * Throws rather than guessing when the count is unreadable.
 */
export async function needsSetup(): Promise<boolean> {
  if (await setupLatched()) return false;

  const [row] = await db.select({ count: sql<number>`count(*)` }).from(user);
  const count = Number(row?.count);

  if (count > 0) {
    await markSetupCompleted();
    return false;
  }
  if (count === 0) return true;

  throw new Error("Could not determine whether any accounts exist");
}
