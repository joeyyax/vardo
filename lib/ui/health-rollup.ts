// Health roll-up for a compose stack or project.

import type { AppCondition } from "@/lib/docker/conditions";

export type RollupMember = {
  status: string;
  /** Set on a compose child, which is skipped. */
  parentAppId?: string | null;
  priority?: "critical" | "standard" | "disposable" | null;
  conditions?: AppCondition[] | null;
  containerStartedAt?: Date | null;
  /** Declared off on purpose. Counted, but kept out of the running fraction. */
  parked?: boolean | null;
};

export type HealthRollup = {
  total: number;
  active: number;
  errors: number;
  deploying: number;
  stopped: number;
  missing: number;
  /** Members on the critical QoS tier. */
  critical: number;
  /** Members carrying a warning or critical condition. */
  attention: number;
  /** Declared off on purpose. Counted only in `total`. */
  parked: number;
};

/** Members not stopped by an operator. */
export function liveTotal(rollup: HealthRollup): number {
  return rollup.total - rollup.parked;
}

/** Counts a group one level deep, skipping rows with `parentAppId`. */
export function rollupHealth(members: RollupMember[]): HealthRollup {
  const rollup: HealthRollup = {
    total: 0,
    active: 0,
    errors: 0,
    deploying: 0,
    stopped: 0,
    missing: 0,
    critical: 0,
    attention: 0,
    parked: 0,
  };

  for (const member of members) {
    if (member.parentAppId) continue;
    rollup.total++;
    if (member.priority === "critical") rollup.critical++;
    // Operator-stopped members don't count toward state.
    if (member.parked) {
      rollup.parked++;
      continue;
    }
    if (member.status === "active") rollup.active++;
    else if (member.status === "error") rollup.errors++;
    else if (member.status === "deploying") rollup.deploying++;
    else if (member.status === "missing") rollup.missing++;
    else if (member.status === "stopped") rollup.stopped++;
    if (member.conditions?.some((c) => c.severity === "critical" || c.severity === "warning")) {
      rollup.attention++;
    }
  }

  return rollup;
}

/** Newest container start among running members, or null when none run. */
export function rollupUptimeSince(members: RollupMember[]): Date | null {
  let newest: Date | null = null;
  for (const member of members) {
    if (member.parentAppId || member.parked || member.status !== "active") continue;
    const started = member.containerStartedAt;
    if (started && (!newest || started > newest)) newest = started;
  }
  return newest;
}

/** State hue for the group, worst first. */
export function rollupTone(rollup: HealthRollup): string {
  const live = liveTotal(rollup);
  if (rollup.errors > 0) return "text-status-error";
  if (rollup.deploying > 0) return "text-status-info";
  if (live > 0 && rollup.active === live) return "text-status-success";
  if (rollup.active > 0) return "text-status-warning";
  return "text-status-neutral";
}

/** `noun` is the singular member word — "service" for a stack, "app" for a project. */
export function rollupLabel(rollup: HealthRollup, noun: string): string {
  const plural = `${noun}s`;
  if (rollup.total === 0) return `No ${plural}`;
  const live = liveTotal(rollup);
  if (live === 0) return "Stopped";
  if (rollup.errors > 0) return `${rollup.errors} crashed`;
  if (rollup.deploying > 0) return `${rollup.deploying} deploying`;
  if (rollup.stopped === live) return "Stopped";
  return `${rollup.active}/${live} ${live === 1 ? noun : plural}`;
}

/** True while the group is fully up, which is when the dot pulses. */
export function rollupIsSteady(rollup: HealthRollup): boolean {
  const live = liveTotal(rollup);
  return live > 0 && rollup.active === live;
}
