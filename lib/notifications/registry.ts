// Every alert Vardo emails about: its category, throttle and whether it sends a resolved notice.

export type AlertSeverity = "warning" | "critical";

export type Throttle =
  /** Once per subject until the condition clears, and never again inside `minHours`. Held in `notification_send`. */
  { kind: "until_clear"; minHours: number };

/** Per-org switches. A summary with a failure in it sends whatever the switch says. */
export const NOTIFICATION_CATEGORIES = {
  backups: {
    label: "Backup summaries",
    description: "One email per batch of backups, drills, restores and imports. Failures always send.",
    default: true,
  },
  host: {
    label: "Host alerts",
    description: "Memory, swap, CPU, load and disk on the server.",
    default: true,
  },
  apps: {
    label: "App alerts",
    description: "Out-of-memory kills, restart loops, memory limits and failing health checks.",
    default: true,
  },
} as const;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;

export const NOTIFICATION_CATEGORY_KEYS = Object.keys(NOTIFICATION_CATEGORIES) as NotificationCategory[];

export interface AlertDef {
  category: Exclude<NotificationCategory, "backups">;
  label: string;
  throttle: Throttle;
  /** Emails again when the condition clears. */
  resolves: boolean;
}

function define(def: AlertDef): AlertDef {
  return def;
}

export const ALERTS = {
  "host.memory": define({ category: "host", label: "Host memory", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
  "host.swap": define({ category: "host", label: "Host swap", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
  "host.cpu": define({ category: "host", label: "Host CPU", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
  "host.load": define({ category: "host", label: "Host load", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
  "host.disk": define({ category: "host", label: "Host disk", throttle: { kind: "until_clear", minHours: 6 }, resolves: true }),
  "app.oom": define({ category: "apps", label: "Killed for memory", throttle: { kind: "until_clear", minHours: 1 }, resolves: false }),
  "app.restart-loop": define({ category: "apps", label: "Restart loop", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
  "app.memory-limit": define({ category: "apps", label: "Memory near limit", throttle: { kind: "until_clear", minHours: 6 }, resolves: true }),
  "app.unhealthy": define({ category: "apps", label: "Health check failing", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
};

export type AlertType = keyof typeof ALERTS;

export function isAlertType(value: string): value is AlertType {
  return Object.hasOwn(ALERTS, value);
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { warning: 1, critical: 2 };

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity as AlertSeverity] ?? 0;
}
