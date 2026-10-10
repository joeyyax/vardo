// Which zone the instance and each org schedule and print times in.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { isValidTimeZone, serverTimeZone } from "@/lib/time-zone";

export const TIME_ZONE_SETTING = "time_zone";

/** The admin-set zone, or null when the instance follows the server's. */
export async function getStoredInstanceTimeZone(): Promise<string | null> {
  const raw = await getSystemSettingRaw(TIME_ZONE_SETTING).catch(() => null);
  return isValidTimeZone(raw) ? raw : null;
}

/** The instance's zone: the admin setting, then the server's TZ, then UTC. */
export async function getInstanceTimeZone(): Promise<string> {
  return (await getStoredInstanceTimeZone()) ?? serverTimeZone();
}

/** Null goes back to the server's zone. */
export async function setInstanceTimeZone(tz: string | null): Promise<void> {
  if (tz !== null && !isValidTimeZone(tz)) throw new Error(`Unknown time zone: ${tz}`);
  await setSystemSetting(TIME_ZONE_SETTING, tz ?? "");
}

/** An org's own zone over the instance's. */
export function resolveTimeZone(orgTimeZone: string | null | undefined, instanceTimeZone: string): string {
  return isValidTimeZone(orgTimeZone) ? orgTimeZone : instanceTimeZone;
}

/** The zone an org's schedules and emails use. */
export async function getOrgTimeZone(organizationId: string | null | undefined): Promise<string> {
  const instance = await getInstanceTimeZone();
  if (!organizationId) return instance;
  try {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
      columns: { timeZone: true },
    });
    return resolveTimeZone(org?.timeZone, instance);
  } catch {
    return instance;
  }
}
