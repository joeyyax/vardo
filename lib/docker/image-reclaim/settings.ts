// ---------------------------------------------------------------------------
// Instance-wide reclamation settings.
//
// The scheduled sweep is off until someone turns it on. Previewing is always
// available, so the first thing anyone sees is a list, not a deletion.
// ---------------------------------------------------------------------------

import { getSystemSettingRaw, setSystemSetting, invalidateSettingsCache } from "@/lib/system-settings";
import { DEFAULT_IDLE_DAYS, MAX_IDLE_DAYS, MIN_IDLE_DAYS } from "./policy";

const KEY = "image_reclaim";

export interface ImageReclaimConfig {
  /** Whether the scheduled sweep deletes. Off means preview only. */
  enabled: boolean;
  idleDays: number;
  /** Whether the sweep also removes superseded blue-green slot generations. */
  slots: boolean;
}

export const DEFAULT_CONFIG: ImageReclaimConfig = {
  enabled: false,
  idleDays: DEFAULT_IDLE_DAYS,
  slots: false,
};

export function clampIdleDays(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_IDLE_DAYS;
  return Math.min(MAX_IDLE_DAYS, Math.max(MIN_IDLE_DAYS, Math.floor(n)));
}

export async function getImageReclaimConfig(): Promise<ImageReclaimConfig> {
  const raw = await getSystemSettingRaw(KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<ImageReclaimConfig>;
    return {
      enabled: parsed.enabled === true,
      idleDays: clampIdleDays(parsed.idleDays ?? DEFAULT_IDLE_DAYS),
      slots: parsed.slots === true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Summary of the last sweep, so the UI can show what was reclaimed after the fact. */
export interface LastRunSummary {
  finishedAt: string;
  imagesRemoved: number;
  appsAffected: number;
  estimatedBytesFreed: number;
  failures: number;
  apps: string[];
}

const LAST_RUN_KEY = "image_reclaim_last_run";

export async function getLastRun(): Promise<LastRunSummary | null> {
  const raw = await getSystemSettingRaw(LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastRunSummary;
  } catch {
    return null;
  }
}

export async function recordLastRun(result: {
  finishedAt: string;
  reclaimed: { appName: string; freedLayers: boolean }[];
  failed: unknown[];
  estimatedBytesFreed: number;
  appsAffected: number;
}): Promise<void> {
  const summary: LastRunSummary = {
    finishedAt: result.finishedAt,
    imagesRemoved: result.reclaimed.filter((r) => r.freedLayers).length,
    appsAffected: result.appsAffected,
    estimatedBytesFreed: result.estimatedBytesFreed,
    failures: result.failed.length,
    apps: [...new Set(result.reclaimed.map((r) => r.appName))],
  };
  await setSystemSetting(LAST_RUN_KEY, JSON.stringify(summary));
  invalidateSettingsCache(LAST_RUN_KEY);
}

export async function setImageReclaimConfig(config: ImageReclaimConfig): Promise<void> {
  await setSystemSetting(
    KEY,
    JSON.stringify({
      enabled: config.enabled,
      idleDays: clampIdleDays(config.idleDays),
      slots: config.slots === true,
    }),
  );
  invalidateSettingsCache(KEY);
}
