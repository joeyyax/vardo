// Every alert Vardo emails about: its category, throttle and whether it sends a resolved notice.

export type AlertSeverity = "warning" | "critical";

export type Throttle =
  /** Once per subject until the condition clears, and never again inside `minHours`. Held in `notification_send`. */
  { kind: "until_clear"; minHours: number };

/** Per-org switches. A summary with a failure in it sends whatever the switch says. */
export const NOTIFICATION_CATEGORIES = {
  backups: {
    label: "Backup failures",
    description: "Failures as they happen, and a run summary when something failed, was skipped or changed size sharply.",
    default: true,
  },
  backupSummaries: {
    label: "Every nightly backup summary",
    description: "Email the nightly summary even when nothing needs a look. Off, a clean run goes to the digest.",
    default: false,
  },
  deploySuccess: {
    label: "Every successful deploy",
    description: "Email deploys started by a push or the API too. Off, only deploys started by hand email; the rest go to the digest.",
    default: false,
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
  anomalies: {
    label: "Unusual app activity",
    description: "An app using far more CPU, network or disk than its own normal, or running a process or port it never has.",
    default: true,
  },
  cron: {
    label: "Cron failures",
    description: "Once when a cron job starts failing and again when it recovers.",
    default: true,
  },
} as const;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;

export const NOTIFICATION_CATEGORY_KEYS = Object.keys(NOTIFICATION_CATEGORIES) as NotificationCategory[];

export interface AlertDef {
  category: Exclude<NotificationCategory, "backupSummaries" | "deploySuccess">;
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
  "backup.failure": define({ category: "backups", label: "Backup failed", throttle: { kind: "until_clear", minHours: 6 }, resolves: false }),
  "app.unhealthy": define({ category: "apps", label: "Health check failing", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
  "app.anomaly": define({ category: "anomalies", label: "Unusual resource use", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
  "app.new-port": define({ category: "anomalies", label: "New listening port", throttle: { kind: "until_clear", minHours: 1 }, resolves: false }),
  "app.new-process": define({ category: "anomalies", label: "Unexpected process", throttle: { kind: "until_clear", minHours: 1 }, resolves: false }),
  "cron.failure": define({ category: "cron", label: "Cron job failing", throttle: { kind: "until_clear", minHours: 1 }, resolves: true }),
};

export type AlertType = keyof typeof ALERTS;

export function isAlertType(value: string): value is AlertType {
  return Object.hasOwn(ALERTS, value);
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { warning: 1, critical: 2 };

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity as AlertSeverity] ?? 0;
}
