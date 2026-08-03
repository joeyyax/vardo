// ---------------------------------------------------------------------------
// cAdvisor disk metrics setting
//
// Filesystem and disk I/O collection walks every container's filesystem,
// which is what pushes cAdvisor's own memory ceiling from 256m to 512m.
// Turning it off trades per-container disk figures for a smaller footprint
// on a memory-constrained host. cAdvisor has no per-metric interval, so this
// is all-or-nothing — see --help, there's no slower cadence to fall back to.
// ---------------------------------------------------------------------------

import { getSystemSettingRaw, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import { logger } from "@/lib/logger";

const log = logger.child("cadvisor-config");

const KEY = "cadvisor_config";

export interface CadvisorConfig {
  diskMetricsEnabled: boolean;
}

export const DEFAULT_CADVISOR_CONFIG: CadvisorConfig = {
  diskMetricsEnabled: true,
};

export async function getCadvisorConfig(): Promise<CadvisorConfig> {
  const raw = await getSystemSettingRaw(KEY);
  if (!raw) return { ...DEFAULT_CADVISOR_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<CadvisorConfig>;
    return { diskMetricsEnabled: parsed.diskMetricsEnabled !== false };
  } catch {
    return { ...DEFAULT_CADVISOR_CONFIG };
  }
}

export async function setCadvisorConfig(config: CadvisorConfig): Promise<void> {
  await setSystemSetting(KEY, JSON.stringify(config));
  invalidateSettingsCache(KEY);
}

// ---------------------------------------------------------------------------
// Compose transform
//
// The template ships with disk metrics on, so only the off state needs a
// rewrite. Each swap replaces a comment + line pair so the compose an
// operator reads back never contradicts what it's actually running.
// ---------------------------------------------------------------------------

const COMMAND_ON = `      # disk and diskIO drive per-container filesystem usage and write rates.
      - --disable_metrics=udp,percpu`;
const COMMAND_OFF = `      # disk and diskIO off — toggled from Core services.
      - --disable_metrics=udp,percpu,disk,diskIO`;

const MEM_ON = `    # Disk metrics walk every container's filesystem, so this is not 256m.
    mem_limit: 512m`;
const MEM_OFF = `    # Disk metrics off — 256m is enough without filesystem walks.
    mem_limit: 256m`;

/**
 * Rewrite the cAdvisor template's compose content to match the disk metrics
 * setting. Falls back to the unmodified (disk-on) content and logs an error
 * if the template no longer matches the expected markers, rather than
 * writing out compose that silently doesn't reflect the setting.
 */
export function applyCadvisorDiskMetrics(composeContent: string, diskMetricsEnabled: boolean): string {
  if (diskMetricsEnabled) return composeContent;

  if (!composeContent.includes(COMMAND_ON) || !composeContent.includes(MEM_ON)) {
    log.error("cAdvisor template markers not found — leaving disk metrics on");
    return composeContent;
  }

  return composeContent.replace(COMMAND_ON, COMMAND_OFF).replace(MEM_ON, MEM_OFF);
}
