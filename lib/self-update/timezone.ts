// The instance's time zone for update windows without their own: the admin setting, then the server's TZ.

import { getInstanceTimeZone } from "@/lib/time-zone-settings";

export async function getInstanceTimezone(): Promise<string | null> {
  return getInstanceTimeZone().catch(() => null);
}
