// Host reclaim settings, the last run, and the deploy marker that schedules the next one.

import { redis } from "@/lib/redis";
import { getSystemSettingRaw, invalidateSettingsCache, setSystemSetting } from "@/lib/system-settings";

const CONFIG_KEY = "host_reclaim";
const LAST_RUN_KEY = "host_reclaim_last_run";
const DEPLOY_AT_KEY = "host-reclaim:deploy-at";

export type ReclaimTrigger = "deploy" | "nightly" | "disk" | "manual";

export interface HostReclaimConfig {
  enabled: boolean;
  /** Unused tagged images younger than this stay. */
  minImageAgeHours: number;
}

export const DEFAULT_HOST_RECLAIM: HostReclaimConfig = { enabled: true, minImageAgeHours: 48 };

const MIN_AGE_HOURS = 1;
const MAX_AGE_HOURS = 24 * 90;

export function clampAgeHours(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_HOST_RECLAIM.minImageAgeHours;
  return Math.min(MAX_AGE_HOURS, Math.max(MIN_AGE_HOURS, Math.floor(n)));
}

export async function getHostReclaimConfig(): Promise<HostReclaimConfig> {
  const raw = await getSystemSettingRaw(CONFIG_KEY);
  if (!raw) return { ...DEFAULT_HOST_RECLAIM };
  try {
    const parsed = JSON.parse(raw) as Partial<HostReclaimConfig>;
    return {
      enabled: parsed.enabled !== false,
      minImageAgeHours: clampAgeHours(parsed.minImageAgeHours ?? DEFAULT_HOST_RECLAIM.minImageAgeHours),
    };
  } catch {
    return { ...DEFAULT_HOST_RECLAIM };
  }
}

export async function setHostReclaimConfig(config: HostReclaimConfig): Promise<void> {
  await setSystemSetting(
    CONFIG_KEY,
    JSON.stringify({ enabled: config.enabled === true, minImageAgeHours: clampAgeHours(config.minImageAgeHours) }),
  );
  invalidateSettingsCache(CONFIG_KEY);
}

export interface HostReclaimRun {
  trigger: ReclaimTrigger;
  startedAt: string;
  finishedAt: string;
  /** Set when the run did nothing, with the reason. */
  skipped?: string;
  buildCacheBytes: number;
  danglingImages: number;
  danglingBytes: number;
  unusedImages: number;
  /** Upper bound: layers shared with kept images free nothing. */
  unusedBytes: number;
  containers: number;
  failures: number;
}

export function freedBytes(run: HostReclaimRun): number {
  return run.buildCacheBytes + run.danglingBytes + run.unusedBytes;
}

export async function getLastHostReclaim(): Promise<HostReclaimRun | null> {
  invalidateSettingsCache(LAST_RUN_KEY);
  const raw = await getSystemSettingRaw(LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HostReclaimRun;
  } catch {
    return null;
  }
}

export async function recordHostReclaim(run: HostReclaimRun): Promise<void> {
  await setSystemSetting(LAST_RUN_KEY, JSON.stringify(run));
  invalidateSettingsCache(LAST_RUN_KEY);
}

/** Called when a deploy finishes, so the next quiet spell reclaims. */
export async function markDeployForReclaim(now = Date.now()): Promise<void> {
  await redis.set(DEPLOY_AT_KEY, String(now));
}

export async function lastDeployAt(): Promise<number | null> {
  const raw = await redis.get(DEPLOY_AT_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}
