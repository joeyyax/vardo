// The never-ban list in system_settings.

import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { normalizeAllowlist, type AllowEntry } from "./allowlist";

export const ALLOWLIST_KEY = "probe_guard_allowlist";

export async function getAllowlist(): Promise<AllowEntry[]> {
  const raw = await getSystemSettingRaw(ALLOWLIST_KEY).catch(() => null);
  if (!raw) return [];
  try {
    return normalizeAllowlist(JSON.parse(raw));
  } catch {
    return [];
  }
}

export async function setAllowlist(entries: readonly AllowEntry[]): Promise<void> {
  await setSystemSetting(ALLOWLIST_KEY, JSON.stringify({ entries }));
}
