// Instance-wide UPS power policies, kept in system_settings.

import { z } from "zod";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { logger } from "@/lib/logger";

const log = logger.child("power");

export const POWER_POLICY_KEY = "power_policies";

export type PowerPolicies = {
  /** Scheduled backups due on battery are skipped. */
  skipBackups: boolean;
  /** New deploys wait until power returns. */
  holdDeploys: boolean;
  /** Apps stop after `stopAfterMinutes` on battery or at `stopBelowCharge` percent, whichever comes first. */
  stopApps: boolean;
  /** Null turns the minutes trigger off. */
  stopAfterMinutes: number | null;
  /** Null turns the charge trigger off. */
  stopBelowCharge: number | null;
};

export const DEFAULT_POWER_POLICIES: PowerPolicies = {
  skipBackups: true,
  holdDeploys: true,
  stopApps: false,
  stopAfterMinutes: 10,
  stopBelowCharge: 30,
};

export const powerPoliciesSchema = z
  .object({
    skipBackups: z.boolean(),
    holdDeploys: z.boolean(),
    stopApps: z.boolean(),
    stopAfterMinutes: z.number().int().min(1).max(24 * 60).nullable(),
    stopBelowCharge: z.number().int().min(1).max(99).nullable(),
  })
  .refine((p) => !p.stopApps || p.stopAfterMinutes !== null || p.stopBelowCharge !== null, {
    message: "Set minutes on battery, a charge level or both",
    path: ["stopAfterMinutes"],
  });

/** Stored policies over the defaults. A field that doesn't parse keeps its default. */
export function parsePowerPolicies(raw: string | null): PowerPolicies {
  if (!raw) return DEFAULT_POWER_POLICIES;
  try {
    const stored = JSON.parse(raw) as Partial<PowerPolicies>;
    const merged = { ...DEFAULT_POWER_POLICIES, ...stored };
    const parsed = powerPoliciesSchema.safeParse(merged);
    return parsed.success ? parsed.data : DEFAULT_POWER_POLICIES;
  } catch {
    log.warn("Couldn't parse the stored power policies; using the defaults");
    return DEFAULT_POWER_POLICIES;
  }
}

export async function getPowerPolicies(): Promise<PowerPolicies> {
  return parsePowerPolicies(await getSystemSettingRaw(POWER_POLICY_KEY));
}

export async function setPowerPolicies(policies: PowerPolicies): Promise<void> {
  await setSystemSetting(POWER_POLICY_KEY, JSON.stringify(policies));
}
