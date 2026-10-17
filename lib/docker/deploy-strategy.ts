// How a deploy hands over from the live slot to the new one.

import type { ComposeFile, ComposeService } from "./compose-types";
import { declaredVolumes } from "./volume-shared";

/** blue-green runs both slots until the new one is healthy; stop-first stops the old slot before the new one starts. */
export const DEPLOY_STRATEGIES = ["blue-green", "stop-first"] as const;
export type DeployStrategy = (typeof DEPLOY_STRATEGIES)[number];

/** Errors from software that couldn't take a lock another process holds. */
const LOCK_ERRORS = [
  /LEVEL_LOCKED/,
  /\block\b.*resource temporarily unavailable/i,
  /database is locked/i,
  /(could not|couldn't|unable to|failed to|cannot) (acquire|obtain|get|take) (an? |the )?(exclusive |file |database )?lock/i,
  /locked by another (process|instance)/i,
];

const MAX_QUOTED = 200;

/** The first log line reporting a held lock, or null. */
export function lockErrorLine(logs: string): string | null {
  for (const line of logs.split(/\r?\n/)) {
    if (LOCK_ERRORS.some((re) => re.test(line))) {
      const trimmed = line.trim();
      return trimmed.length > MAX_QUOTED ? `${trimmed.slice(0, MAX_QUOTED)}…` : trimmed;
    }
  }
  return null;
}

/** Declared volumes and absolute host paths a rotating service mounts, which both slots open. */
export function crossSlotMounts(compose: ComposeFile, slotted: Record<string, ComposeService>): string[] {
  const declared = declaredVolumes(compose);
  const mounts = new Set<string>();
  for (const service of Object.values(slotted)) {
    for (const mount of service.volumes ?? []) {
      const source = mount.split(":")[0];
      if (source.startsWith("/") || declared.has(source)) mounts.add(source);
    }
  }
  return [...mounts];
}

/** Suggests stop-first when the new slot logged a lock error while both slots ran on the same data. */
export function lockConflictHint(opts: {
  logs: string;
  compose: ComposeFile;
  slotted: Record<string, ComposeService>;
  overlapped: boolean;
  activeSlot: string;
  newSlot: string;
}): string | null {
  if (!opts.overlapped) return null;
  const line = lockErrorLine(opts.logs);
  if (!line) return null;
  const mounts = crossSlotMounts(opts.compose, opts.slotted);
  if (mounts.length === 0) return null;
  return (
    `${opts.newSlot} logged a lock error while ${opts.activeSlot} was still running on the same data (${mounts.join(", ")}): ${line}\n` +
    `Only one copy can hold that lock. Set Deploy strategy to Stop first in the app's Build settings so ${opts.activeSlot} stops before ${opts.newSlot} starts.`
  );
}
