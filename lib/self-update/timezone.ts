// The instance's time zone, when one is configured. Windows fall back to their own zone without it.

import { getSystemSettingRaw } from "@/lib/system-settings";
import { isValidTimeZone } from "./window";

const KEYS = ["instance_timezone", "timezone"];

function pick(raw: string | null): string | null {
  if (!raw) return null;
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // A bare zone name.
  }
  if (value && typeof value === "object") {
    const o = value as { timezone?: unknown; timeZone?: unknown };
    value = o.timezone ?? o.timeZone;
  }
  return typeof value === "string" && isValidTimeZone(value) ? value : null;
}

export async function getInstanceTimezone(): Promise<string | null> {
  for (const key of KEYS) {
    const tz = pick(await getSystemSettingRaw(key).catch(() => null));
    if (tz) return tz;
  }
  return pick(await getSystemSettingRaw("instance_config").catch(() => null));
}
