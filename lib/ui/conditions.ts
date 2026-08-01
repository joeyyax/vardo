import type { AppCondition, ConditionSeverity } from "@/lib/docker/conditions";

/** Short enough to sit inline after an app name in a list row. */
export function conditionLabel(c: AppCondition): string {
  switch (c.kind) {
    case "crash-looping":
      return "crash looping";
    case "self-heal-exhausted":
      return "restarts exhausted";
    case "unhealthy":
      return "unhealthy";
    case "memory-pressure": {
      const pct = c.detail.match(/^(\d+)%/)?.[1];
      return pct ? `${pct}% memory` : "memory pressure";
    }
    case "security-findings": {
      const n = c.detail.match(/^(\d+)/)?.[1];
      return c.severity === "critical" ? `${n ?? ""} critical`.trim() : `${n ?? ""} warnings`.trim();
    }
    case "backup-missing":
      return "no backup";
    case "backup-stale":
      return "backup overdue";
  }
}

export function conditionTone(severity: ConditionSeverity): string {
  return severity === "critical"
    ? "text-status-error"
    : severity === "warning"
      ? "text-status-warning"
      : "text-muted-foreground";
}

/** Apps needing attention, for a project-level rollup. */
export function countNeedingAttention(
  apps: { conditions?: AppCondition[] | null }[],
): { critical: number; warning: number } {
  let critical = 0;
  let warning = 0;
  for (const a of apps) {
    const worst = a.conditions?.reduce<AppCondition | null>(
      (w, c) => (!w || (c.severity === "critical" && w.severity !== "critical") ? c : w),
      null,
    );
    if (!worst) continue;
    if (worst.severity === "critical") critical++;
    else if (worst.severity === "warning") warning++;
  }
  return { critical, warning };
}
