// This host's power as one server-side read, for features that act on it.

import { UPS_POLL_INTERVAL_MS, testOutcome, upsHealth, type UpsHealth, type UpsState } from "./status";
import { listUpsServers } from "./store";
import type { UpsServerRow } from "@/lib/db/schema";

/** A reading older than this is stale. */
export const POWER_FRESH_MS = 4 * UPS_POLL_INTERVAL_MS;

export type UpsPower = {
  id: string;
  name: string;
  onBattery: boolean;
  /** When the current outage started. Null while on line power. */
  since: Date | null;
  /** Percent. */
  charge: number | null;
  /** Seconds. */
  runtimeSec: number | null;
  lowBattery: boolean;
  /** The last good reading is recent enough to act on. */
  fresh: boolean;
  readAt: Date | null;
};

export type PowerState = {
  /** At least one UPS is set up and enabled. */
  monitored: boolean;
  /** Any UPS with fresh data is on battery. */
  onBattery: boolean;
  /** The earliest start among UPSes on battery. */
  since: Date | null;
  /** The UPS on battery with the least runtime, else the one with the least runtime. */
  charge: number | null;
  runtimeSec: number | null;
  /** Every enabled UPS has fresh data. */
  fresh: boolean;
  upses: UpsPower[];
};

export function upsPower(row: Pick<UpsServerRow, "id" | "name">, state: UpsState | null, now: Date): UpsPower {
  const r = state?.reading ?? null;
  const readAt = state?.lastOkAt ? new Date(state.lastOkAt) : null;
  const onBattery = !!r?.flags.includes("OB");
  return {
    id: row.id,
    name: row.name,
    onBattery,
    since: onBattery && state?.onBatterySince ? new Date(state.onBatterySince) : null,
    charge: r?.charge ?? null,
    runtimeSec: r?.runtime ?? null,
    lowBattery: !!r?.flags.includes("LB"),
    fresh: !!readAt && now.getTime() - readAt.getTime() <= POWER_FRESH_MS,
    readAt,
  };
}

/** Folds per-UPS power into the host's. */
export function combinePower(upses: UpsPower[]): PowerState {
  const freshOnBattery = upses.filter((u) => u.fresh && u.onBattery);
  const pool = freshOnBattery.length > 0 ? freshOnBattery : upses.filter((u) => u.fresh);
  const worst = [...pool].sort((a, b) => (a.runtimeSec ?? Infinity) - (b.runtimeSec ?? Infinity))[0] ?? null;
  const starts = freshOnBattery.map((u) => u.since).filter((d): d is Date => d !== null);
  return {
    monitored: upses.length > 0,
    onBattery: freshOnBattery.length > 0,
    since: starts.length > 0 ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null,
    charge: worst?.charge ?? null,
    runtimeSec: worst?.runtimeSec ?? null,
    fresh: upses.length > 0 && upses.every((u) => u.fresh),
    upses,
  };
}

export type UpsReport = UpsPower & {
  health: UpsHealth;
  status: string | null;
  model: string | null;
  load: number | null;
  replaceBattery: boolean;
  testFailed: string | null;
  lastError: string | null;
};

/** Each enabled UPS as the doctor and instance status show it. */
export async function readUpsReports(now = new Date()): Promise<UpsReport[]> {
  const rows = (await listUpsServers()).filter((r) => r.enabled);
  return rows.map((row) => {
    const r = row.state?.reading ?? null;
    return {
      ...upsPower(row, row.state, now),
      health: upsHealth(row.state),
      status: r?.status ?? null,
      model: [r?.mfr, r?.model].filter(Boolean).join(" ") || null,
      load: r?.load ?? null,
      replaceBattery: !!r?.flags.includes("RB"),
      testFailed: testOutcome(r?.testResult ?? null) === "failed" ? r!.testResult : null,
      lastError: row.state?.lastError ?? null,
    };
  });
}

/** The host's power now, from the poller's last state. */
export async function getPowerState(now = new Date()): Promise<PowerState> {
  const rows = (await listUpsServers()).filter((r) => r.enabled);
  return combinePower(rows.map((r) => upsPower(r, r.state, now)));
}
