// Instance-wide probe guard settings and the key Traefik tags guarded requests with.

import { createHmac, timingSafeEqual } from "crypto";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { normalizeMasterKey } from "@/lib/crypto/key-fingerprint";
import { normalizeInstanceProbeGuard, type InstanceProbeGuard } from "./settings";

export const SETTINGS_KEY = "probe_guard";

export async function getProbeGuardSettings(): Promise<InstanceProbeGuard> {
  const raw = await getSystemSettingRaw(SETTINGS_KEY).catch(() => null);
  if (!raw) return normalizeInstanceProbeGuard(null);
  try {
    return normalizeInstanceProbeGuard(JSON.parse(raw));
  } catch {
    return normalizeInstanceProbeGuard(null);
  }
}

export async function setProbeGuardSettings(settings: InstanceProbeGuard): Promise<void> {
  await setSystemSetting(SETTINGS_KEY, JSON.stringify(settings));
}

/** Derived from the master key, so every process agrees without storing it. Null without a key. */
export function guardKey(env: Record<string, string | undefined> = process.env): string | null {
  const master = env.ENCRYPTION_MASTER_KEY;
  if (!master) return null;
  return createHmac("sha256", normalizeMasterKey(master)).update("vardo-probe-guard/v1").digest("hex");
}

/** Whether a request carries the key Traefik's guard middleware sets. */
export function hasGuardKey(value: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const key = guardKey(env);
  if (!key || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
