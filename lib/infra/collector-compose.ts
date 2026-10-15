// The collector's compose on this host: `pid: host` on GPU hosts only.

import { logger } from "@/lib/logger";

const log = logger.child("collector-compose");

const SERVICE = /^( +)collector:\n/m;

/** Adds `pid: host` so nvidia-smi sees other containers' GPU processes. Unchanged without a GPU. */
export function applyCollectorGpu(composeContent: string, hasGpu: boolean): string {
  if (!hasGpu) return composeContent;
  const match = SERVICE.exec(composeContent);
  if (!match) {
    log.error("Collector service not found in its template; per-container GPU memory stays off");
    return composeContent;
  }
  const indent = `${match[1]}${match[1]}`;
  return composeContent.replace(SERVICE, `${match[0]}${indent}# GPU host: per-container GPU memory needs the host PID namespace.\n${indent}pid: host\n`);
}
