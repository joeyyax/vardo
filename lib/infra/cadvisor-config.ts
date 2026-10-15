// cAdvisor disk metrics setting. Off (default) skips the per-container filesystem walk and holds the memory ceiling at 256m; on raises it to 512m.

import { logger } from "@/lib/logger";
import { collectorMode } from "@/lib/collector/config";

const log = logger.child("cadvisor-config");

/** Whether cAdvisor walks container filesystems. With a collector, Docker measures them instead. */
export function cadvisorWalksDisk(diskMetricsEnabled: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return diskMetricsEnabled && collectorMode(env).kind === "off";
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
