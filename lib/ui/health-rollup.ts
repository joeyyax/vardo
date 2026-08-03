// ---------------------------------------------------------------------------
// Group health roll-up
//
// A compose stack and a project are the same idea: a group of apps shown as one
// health entity. Both headers roll up through this.
// ---------------------------------------------------------------------------

import type { AppCondition } from "@/lib/docker/conditions";

export type RollupMember = {
  status: string;
  /** Set on a compose child. Its parent already counts it, so it is skipped here. */
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
  /** Members on the critical QoS tier — auto-restarted, memory limit required. */
  critical: number;
  /** Members carrying a warning or critical condition. */
  attention: number;
  /** Declared off on purpose. Part of `total`, absent from every other count. */
  parked: number;
};

/** Members expected to be doing something. Nothing else is judged against them. */
export function liveTotal(rollup: HealthRollup): number {
  return rollup.total - rollup.parked;
}

/**
 * Counts a group one level deep. Rows nested under a parent in the same list
 * are dropped, the way project totals exclude `parentAppId` rows — pass a
 * stack's children directly and every one of them counts.
 */
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
    // A parked member is inventory. Counting its state would put a group at
    // "2/3" or "1 crashed" over something nobody is waiting on.
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

/**
 * Newest container start among the running members — how long every one of them
 * has been up, so the group never claims more than its shortest-lived member.
 * Null when nothing in the group is running.
 */
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
  // Everything shelved reads as the declaration, not as a group that failed.
  const live = liveTotal(rollup);
  if (live === 0) return "Parked";
  if (rollup.errors > 0) return `${rollup.errors} crashed`;
  if (rollup.deploying > 0) return `${rollup.deploying} deploying`;
  // A fully stopped group reads as its state, not as a count of zero.
  if (rollup.stopped === live) return "Stopped";
  return `${rollup.active}/${live} ${live === 1 ? noun : plural}`;
}

/** True while the group is fully up, which is when the dot pulses. */
export function rollupIsSteady(rollup: HealthRollup): boolean {
  const live = liveTotal(rollup);
  return live > 0 && rollup.active === live;
}
