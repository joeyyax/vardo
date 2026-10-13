// Whether new archives are encrypted. On unless an admin turns it off; existing archives keep how they were written.

import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";

const KEY = "backup_encryption";

export async function getBackupEncryptionEnabled(): Promise<boolean> {
  return (await getSystemSettingRaw(KEY)) !== "off";
}

export async function setBackupEncryptionEnabled(enabled: boolean): Promise<void> {
  await setSystemSetting(KEY, enabled ? "on" : "off");
}
