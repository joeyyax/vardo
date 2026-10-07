// cAdvisor disk metrics setting. Off drops per-container disk figures and lowers cAdvisor's memory ceiling from 512m to 256m.

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

// Compose transform. The template ships with disk metrics on, so only off needs a rewrite.

/** Kept in step with templates/cadvisor.yaml; both markers below embed it. */
const DISABLED_METRICS =
  "advtcp,cpu_topology,cpuset,hugetlb,memory_numa,percpu,process,referenced_memory,resctrl,sched,tcp,udp";

const COMMAND_ON = `      # cAdvisor's own default disable list plus percpu. Setting this flag
      # replaces that default, so the expensive /proc scanners must be named.
      - --disable_metrics=${DISABLED_METRICS}`;
const COMMAND_OFF = `      # disk and diskIO off — toggled from Core services.
      - --disable_metrics=${DISABLED_METRICS},disk,diskIO`;

const MEM_ON = `    # Disk metrics walk every container's filesystem, so this is not 256m.
    mem_limit: 512m`;
const MEM_OFF = `    # Disk metrics off — 256m is enough without filesystem walks.
    mem_limit: 256m`;

/** Rewrite cAdvisor compose for the disk metrics setting. Logs and returns it unmodified if the markers no longer match. */
export function applyCadvisorDiskMetrics(composeContent: string, diskMetricsEnabled: boolean): string {
  if (diskMetricsEnabled) return composeContent;

  if (!composeContent.includes(COMMAND_ON) || !composeContent.includes(MEM_ON)) {
    log.error("cAdvisor template markers not found — leaving disk metrics on");
    return composeContent;
  }

  return composeContent.replace(COMMAND_ON, COMMAND_OFF).replace(MEM_ON, MEM_OFF);
}
