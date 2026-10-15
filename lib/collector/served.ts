// When the collector first served metrics, kept as a system setting.

import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";

export const FIRST_SERVED_KEY = "collector_first_served_at";

/** Records the collector's first successful read. Later calls only read. */
export async function markCollectorServed(now = new Date()): Promise<void> {
  if (await getSystemSettingRaw(FIRST_SERVED_KEY)) return;
  await setSystemSetting(FIRST_SERVED_KEY, now.toISOString());
}

export async function hasCollectorServed(): Promise<boolean> {
  return !!(await getSystemSettingRaw(FIRST_SERVED_KEY));
}
