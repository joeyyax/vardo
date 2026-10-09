// cAdvisor disk metrics setting. Off (default) skips the per-container filesystem walk and holds the memory ceiling at 256m; on raises it to 512m.

import { getSystemSettingRaw, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import { logger } from "@/lib/logger";

const log = logger.child("cadvisor-config");

const KEY = "cadvisor_config";

export interface CadvisorConfig {
  diskMetricsEnabled: boolean;
}

export const DEFAULT_CADVISOR_CONFIG: CadvisorConfig = {
  diskMetricsEnabled: false,
};

export async function getCadvisorConfig(): Promise<CadvisorConfig> {
  const raw = await getSystemSettingRaw(KEY);
  if (!raw) return { ...DEFAULT_CADVISOR_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<CadvisorConfig>;
    return { diskMetricsEnabled: parsed.diskMetricsEnabled === true };
  } catch {
    return { ...DEFAULT_CADVISOR_CONFIG };
  }
}

export async function setCadvisorConfig(config: CadvisorConfig): Promise<void> {
  await setSystemSetting(KEY, JSON.stringify(config));
  invalidateSettingsCache(KEY);
}

// Compose transform. The template ships with disk metrics off, so only on needs a rewrite.

const DISK_OFF = "--disable_metrics=advtcp,app,cpuLoad,cpu_topology,cpuset,hugetlb,memory_numa,oom_event,percpu,pressure,process,referenced_memory,resctrl,sched,tcp,udp,disk";
const DISK_ON = "--disable_metrics=advtcp,app,cpuLoad,cpu_topology,cpuset,hugetlb,memory_numa,oom_event,percpu,pressure,process,referenced_memory,resctrl,sched,tcp,udp";
const MEM_OFF = `    # 512m with disk metrics on (Core services toggle).
    mem_limit: 256m`;
const MEM_ON = `    # Disk metrics walk every container's filesystem, so this is not 256m.
    mem_limit: 512m`;

/** Rewrite cAdvisor compose for the disk metrics setting. Logs and returns it unmodified if the markers no longer match. */
export function applyCadvisorDiskMetrics(composeContent: string, diskMetricsEnabled: boolean): string {
  if (!diskMetricsEnabled) return composeContent;

  if (!composeContent.includes(DISK_OFF) || !composeContent.includes(MEM_OFF)) {
    log.error("cAdvisor template markers not found — leaving disk metrics off");
    return composeContent;
  }

  return composeContent.replace(DISK_OFF, DISK_ON).replace(MEM_OFF, MEM_ON);
}
