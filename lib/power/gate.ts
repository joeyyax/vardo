// The backup and deploy hooks' read of the power policies. Fails open: an error never holds work.

import { getPowerState, type PowerState } from "@/lib/ups/power-state";
import { logger } from "@/lib/logger";
import { holdsDeploys, outageKey, skipsBackups } from "./policy";
import { getPowerPolicies, type PowerPolicies } from "./settings";

const log = logger.child("power");

/** The deploy claim runs every second; this caps its reads. */
const MEMO_MS = 5_000;

export type PowerGate = { skipBackups: boolean; holdDeploys: boolean; outage: string | null; onBattery: boolean };

const OPEN: PowerGate = { skipBackups: false, holdDeploys: false, outage: null, onBattery: false };

export function gateOf(power: PowerState, policies: PowerPolicies): PowerGate {
  return {
    skipBackups: skipsBackups(power, policies),
    holdDeploys: holdsDeploys(power, policies),
    outage: outageKey(power),
    onBattery: outageKey(power) !== null,
  };
}

let memo: { at: number; gate: Promise<PowerGate> } | null = null;

/** The policies' verdict now, read at most every few seconds. */
export function readPowerGate(now = Date.now()): Promise<PowerGate> {
  if (memo && now - memo.at < MEMO_MS) return memo.gate;
  const gate = Promise.all([getPowerState(new Date(now)), getPowerPolicies()])
    .then(([power, policies]) => gateOf(power, policies))
    .catch((err) => {
      log.warn("Couldn't read the power state; policies stand down:", err);
      return OPEN;
    });
  memo = { at: now, gate };
  return gate;
}

/** Drops the memo, after a settings change. */
export function resetPowerGate(): void {
  memo = null;
}
