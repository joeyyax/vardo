// Abuse reporting settings, key and status in system_settings, which encrypts every value at rest.

import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { maskSecret } from "@/lib/mask-secrets";
import {
  normalizeAbuseSettings,
  normalizeAbuseStatus,
  type AbuseSettings,
  type AbuseStatus,
} from "./abuse-settings";

export const ABUSE_SETTINGS_KEY = "probe_guard_abuse";
export const ABUSE_KEY_KEY = "probe_guard_abuseipdb_key";
export const ABUSE_STATUS_KEY = "probe_guard_abuse_status";
export const DROP_RANGES_KEY = "probe_guard_drop_ranges";

async function readJson(key: string): Promise<unknown> {
  const raw = await getSystemSettingRaw(key).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getAbuseSettings(): Promise<AbuseSettings> {
  return normalizeAbuseSettings(await readJson(ABUSE_SETTINGS_KEY));
}

export async function setAbuseSettings(settings: AbuseSettings): Promise<void> {
  await setSystemSetting(ABUSE_SETTINGS_KEY, JSON.stringify(settings));
}

/** The AbuseIPDB key, server-side only. */
export async function getAbuseApiKey(): Promise<string | null> {
  return (await getSystemSettingRaw(ABUSE_KEY_KEY).catch(() => null)) || null;
}

/** Empty removes the key. */
export async function setAbuseApiKey(key: string | null): Promise<void> {
  await setSystemSetting(ABUSE_KEY_KEY, key ?? "");
}

/** What the client sees of a key: its last four characters. */
export function maskApiKey(key: string | null): string | null {
  return maskSecret(key);
}

export async function getAbuseStatus(): Promise<AbuseStatus> {
  return normalizeAbuseStatus(await readJson(ABUSE_STATUS_KEY));
}

/** Read-modify-write of the status. Only the singleton loops and admin saves write it. */
export async function updateAbuseStatus(change: (s: AbuseStatus) => AbuseStatus): Promise<void> {
  const next = change(await getAbuseStatus());
  await setSystemSetting(ABUSE_STATUS_KEY, JSON.stringify(next));
}

export type DropRanges = { ranges: string[]; fetchedAt: string | null };

export async function getDropRanges(): Promise<DropRanges> {
  const raw = (await readJson(DROP_RANGES_KEY)) as Partial<DropRanges> | null;
  const ranges = Array.isArray(raw?.ranges) ? raw.ranges.filter((r): r is string => typeof r === "string") : [];
  return { ranges, fetchedAt: typeof raw?.fetchedAt === "string" ? raw.fetchedAt : null };
}

export async function setDropRanges(value: DropRanges): Promise<void> {
  await setSystemSetting(DROP_RANGES_KEY, JSON.stringify(value));
}
