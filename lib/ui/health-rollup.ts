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
};

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
  };

  for (const member of members) {
    if (member.parentAppId) continue;
    rollup.total++;
    if (member.status === "active") rollup.active++;
    else if (member.status === "error") rollup.errors++;
    else if (member.status === "deploying") rollup.deploying++;
    else if (member.status === "missing") rollup.missing++;
    else if (member.status === "stopped") rollup.stopped++;
    if (member.priority === "critical") rollup.critical++;
    if (member.conditions?.some((c) => c.severity === "critical" || c.severity === "warning")) {
      rollup.attention++;
    }
  }

  return rollup;
}

/** State hue for the group, worst first. */
export function rollupTone(rollup: HealthRollup): string {
  if (rollup.errors > 0) return "text-status-error";
  if (rollup.deploying > 0) return "text-status-info";
  if (rollup.total > 0 && rollup.active === rollup.total) return "text-status-success";
  if (rollup.active > 0) return "text-status-warning";
  return "text-status-neutral";
}

/** `noun` is the singular member word — "service" for a stack, "app" for a project. */
export function rollupLabel(rollup: HealthRollup, noun: string): string {
  const plural = `${noun}s`;
  if (rollup.total === 0) return `No ${plural}`;
  if (rollup.errors > 0) return `${rollup.errors} crashed`;
  if (rollup.deploying > 0) return `${rollup.deploying} deploying`;
  return `${rollup.active}/${rollup.total} ${rollup.total === 1 ? noun : plural}`;
}

/** True while the group is fully up, which is when the dot pulses. */
export function rollupIsSteady(rollup: HealthRollup): boolean {
  return rollup.total > 0 && rollup.active === rollup.total;
}
