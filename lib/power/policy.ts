// What each power policy decides from the host's power state. No I/O.

import type { PowerState } from "@/lib/ups/power-state";
import { isVardoStack } from "@/lib/self-app-name";
import type { PowerPolicies } from "./settings";

/** Mains has to hold this long before stopped apps come back. */
export const RESTORE_SETTLE_MS = 2 * 60_000;

/** Unknown covers no UPS, a paused one and stale data. Policies act only on a known state. */
export type PowerMode = "mains" | "battery" | "unknown";

export function powerMode(p: PowerState): PowerMode {
  if (!p.monitored || !p.fresh) return "unknown";
  return p.onBattery ? "battery" : "mains";
}

/** On battery past the grace period. */
function batteryPastGrace(p: PowerState): boolean {
  return powerMode(p) === "battery" && p.graceElapsed;
}

export function skipsBackups(p: PowerState, policies: PowerPolicies): boolean {
  return policies.skipBackups && batteryPastGrace(p);
}

export function holdsDeploys(p: PowerState, policies: PowerPolicies): boolean {
  return policies.holdDeploys && batteryPastGrace(p);
}

/** The outage's key: when it started. */
export function outageKey(p: PowerState): string | null {
  return powerMode(p) === "battery" && p.since ? p.since.toISOString() : null;
}

export type StopTrigger = { reason: "minutes" | "charge"; text: string };

/** Why apps should stop now, or null. Minutes count from the outage start. */
export function stopTrigger(p: PowerState, policies: PowerPolicies, now: Date): StopTrigger | null {
  if (!policies.stopApps || powerMode(p) !== "battery") return null;
  const minutes = p.since ? (now.getTime() - p.since.getTime()) / 60_000 : 0;
  if (policies.stopAfterMinutes !== null && p.since && minutes >= policies.stopAfterMinutes) {
    return { reason: "minutes", text: `after ${Math.round(minutes)} min on battery` };
  }
  if (policies.stopBelowCharge !== null && p.charge !== null && p.charge <= policies.stopBelowCharge) {
    return { reason: "charge", text: `at ${p.charge}% charge` };
  }
  return null;
}

export type StopCandidate = {
  id: string;
  name: string;
  displayName: string;
  organizationId: string;
  parentAppId: string | null;
  status: string;
  parked: boolean;
  priority: "critical" | "standard" | "disposable" | null;
  isSystemManaged: boolean;
  keepRunningOnBattery: boolean;
};

const PRIORITY_ORDER = { disposable: 0, standard: 1, critical: 2 } as const;

/** Whether the stop policy may stop this app at all. */
export function stoppable(app: StopCandidate): boolean {
  return !app.parentAppId && !app.isSystemManaged && !isVardoStack(app.name) && !app.keepRunningOnBattery;
}

/** Running apps the stop policy takes down, lowest priority first. A stack stops through its parent. */
export function planStops<T extends StopCandidate>(apps: T[]): T[] {
  return apps
    .filter((a) => stoppable(a) && !a.parked && a.status !== "stopped" && a.status !== "missing")
    .sort((a, b) => PRIORITY_ORDER[a.priority ?? "standard"] - PRIORITY_ORDER[b.priority ?? "standard"] || a.name.localeCompare(b.name));
}

/** Restart order: the reverse of stop order, so critical apps come back first. */
export function planRestarts<T extends { priority: StopCandidate["priority"]; name: string }>(apps: T[]): T[] {
  return [...apps].sort((a, b) => PRIORITY_ORDER[b.priority ?? "standard"] - PRIORITY_ORDER[a.priority ?? "standard"] || a.name.localeCompare(b.name));
}

export type PolicyStep = { action: "stop"; outage: string; trigger: StopTrigger } | { action: "restart" } | { action: "none" };

export type PolicyInput = {
  power: PowerState;
  policies: PowerPolicies;
  now: Date;
  /** When mains was first seen in the current run of mains readings. */
  mainsSince: number | null;
  /** Apps the policy stopped and hasn't restarted. */
  openStops: number;
  /** The outage the stop pass already ran for. */
  stoppedOutage: string | null;
};

/** One tick of the stop policy: the step to take and the mains clock to keep. Anything but mains resets the clock. */
export function decideStep(input: PolicyInput): { step: PolicyStep; mainsSince: number | null } {
  const mode = powerMode(input.power);
  const now = input.now.getTime();
  if (mode === "mains") {
    const mainsSince = input.mainsSince ?? now;
    const settled = now - mainsSince >= RESTORE_SETTLE_MS;
    return { step: settled && input.openStops > 0 ? { action: "restart" } : { action: "none" }, mainsSince };
  }
  if (mode === "battery") {
    const outage = outageKey(input.power);
    const trigger = stopTrigger(input.power, input.policies, input.now);
    if (outage && trigger && input.stoppedOutage !== outage) return { step: { action: "stop", outage, trigger }, mainsSince: null };
  }
  return { step: { action: "none" }, mainsSince: null };
}
