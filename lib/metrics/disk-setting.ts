// Disk metrics: whether Docker measures each container's writable layer. Off by default.

import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";

const KEY = "metrics_disk";
/** Where the setting lived before it had its own key. Read once, when KEY is unset. */
const LEGACY_KEY = "cadvisor_config";

export async function getDiskMetricsEnabled(): Promise<boolean> {
  const raw = await getSystemSettingRaw(KEY);
  if (raw !== null) return raw === "true";
  const enabled = legacyEnabled(await getSystemSettingRaw(LEGACY_KEY));
  await setDiskMetricsEnabled(enabled);
  return enabled;
}

export async function setDiskMetricsEnabled(enabled: boolean): Promise<void> {
  await setSystemSetting(KEY, String(enabled));
}

function legacyEnabled(raw: string | null): boolean {
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { diskMetricsEnabled?: unknown }).diskMetricsEnabled === true;
  } catch {
    return false;
  }
}
